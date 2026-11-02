/**
 * Purchases — stock in.
 *
 * Posting a purchase does three things atomically:
 *   1. increases stock and recomputes the weighted average cost
 *   2. records a payable to the company (unless paid immediately)
 *   3. posts the ledger: Dr Inventory / Cr Supplier / Cr Cash-or-Bank
 *
 * Freight is capitalised into inventory value rather than expensed, which is what
 * a shop actually means by "this load cost me Rs X landed".
 */

import { lineTotalPaisa, MILLI, weightedAvgCostPaisa } from './money';
import { newId } from './ids';
import { buildLedgerRows, ledgerInsertStatements, type LedgerLine } from './ledger';
import { isGuardFailure } from './guard';
import { allocateDocNo } from './numbering';
import { isIdempotencyCollision, normaliseIdempotencyKey } from './idempotency';

export interface PurchaseLineInput {
  productId: string;
  qtyMilli: number;
  ratePaisa: number;
  discountPaisa?: number;
}

export interface PurchaseInput {
  docDate: string;
  companyId: string;
  supplierInvoiceNo?: string;
  lines: PurchaseLineInput[];
  discountPaisa?: number;
  freightPaisa?: number;
  paidCashPaisa?: number;
  paidBankPaisa?: number;
  cashAccountId?: string;
  bankAccountId?: string;
  notes?: string;
  userId?: string;
  idempotencyKey?: string;
}

export interface PostedPurchase {
  id: string;
  purchaseNo: string;
  totalPaisa: number;
  payablePaisa: number;
}

export type PostPurchaseResult =
  | { ok: true; purchase: PostedPurchase; replayed?: boolean }
  | { ok: false; error: string; code?: string };

interface ProductRow {
  id: string;
  name: string;
  qty_on_hand_milli: number;
  avg_cost_paisa: number;
}

export async function postPurchase(
  db: D1Database,
  input: PurchaseInput,
): Promise<PostPurchaseResult> {
  const idempotencyKey = normaliseIdempotencyKey(input.idempotencyKey);

  if (idempotencyKey) {
    const existing = await findPostedPurchase(db, idempotencyKey);
    if (existing) return { ok: true, purchase: existing, replayed: true };
  }

  if (!input.lines || input.lines.length === 0) {
    return { ok: false, error: 'A purchase needs at least one line' };
  }
  for (const line of input.lines) {
    if (!Number.isInteger(line.qtyMilli) || line.qtyMilli <= 0) {
      return { ok: false, error: `Invalid quantity (${line.qtyMilli})` };
    }
    if (!Number.isInteger(line.ratePaisa) || line.ratePaisa < 0) {
      return { ok: false, error: `Invalid rate (${line.ratePaisa})` };
    }
  }

  const company = await db
    .prepare(`SELECT id, name FROM companies WHERE id = ? AND is_active = 1`)
    .bind(input.companyId)
    .first<{ id: string; name: string }>();
  if (!company) return { ok: false, error: 'Company not found' };

  const productIds = [...new Set(input.lines.map((l) => l.productId))];
  const found = await db
    .prepare(
      `SELECT id, name, qty_on_hand_milli, avg_cost_paisa FROM products
       WHERE id IN (${productIds.map(() => '?').join(', ')})`,
    )
    .bind(...productIds)
    .all<ProductRow>();

  const products = new Map<string, ProductRow>();
  for (const row of found.results ?? []) products.set(row.id, row);
  for (const id of productIds) {
    if (!products.get(id)) return { ok: false, error: `Product not found: ${id}` };
  }

  const now = new Date().toISOString();
  const purchaseId = newId('pur');

  let subtotal = 0;
  const computed = input.lines.map((line) => {
    const discount = line.discountPaisa ?? 0;
    const lineTotal = lineTotalPaisa(line.qtyMilli, line.ratePaisa, discount);
    subtotal += lineTotal;
    return { ...line, discountPaisa: discount, lineTotalPaisa: lineTotal };
  });
  if (subtotal < 0) return { ok: false, error: 'Line discounts exceed the subtotal' };

  const billDiscount = input.discountPaisa ?? 0;
  const freight = input.freightPaisa ?? 0;
  const total = subtotal - billDiscount + freight;
  if (total < 0) return { ok: false, error: 'Discount exceeds the purchase value' };

  const paidCash = input.paidCashPaisa ?? 0;
  const paidBank = input.paidBankPaisa ?? 0;
  if (paidCash < 0 || paidBank < 0) return { ok: false, error: 'Payments cannot be negative' };
  if (paidCash + paidBank > total) {
    return { ok: false, error: `Payment (${paidCash + paidBank}) exceeds the purchase total (${total})` };
  }
  const payable = total - paidCash - paidBank;

  if (paidCash > 0 && !input.cashAccountId) {
    return { ok: false, error: 'A cash account is required when paying cash' };
  }
  if (paidBank > 0 && !input.bankAccountId) {
    return { ok: false, error: 'A bank account is required when paying by bank' };
  }

  const { docNo: purchaseNo } = await allocateDocNo(db, 'purchase', input.docDate);

  const statements: D1PreparedStatement[] = [];

  statements.push(
    db
      .prepare(
        `INSERT INTO purchases
           (id, purchase_no, doc_date, company_id, supplier_invoice_no, subtotal_paisa,
            discount_paisa, freight_paisa, total_paisa, paid_cash_paisa, paid_bank_paisa,
            payable_paisa, cash_account_id, bank_account_id, notes, created_at, idempotency_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        purchaseId,
        purchaseNo,
        input.docDate,
        input.companyId,
        input.supplierInvoiceNo ?? null,
        subtotal,
        billDiscount,
        freight,
        total,
        paidCash,
        paidBank,
        payable,
        input.cashAccountId ?? null,
        input.bankAccountId ?? null,
        input.notes ?? null,
        now,
        idempotencyKey,
      ),
  );

  // Stock up + weighted average cost, computed on a running basis so two lines of
  // the same product arriving together are averaged correctly.
  const runningQty = new Map<string, number>();
  const runningAvg = new Map<string, number>();
  for (const p of products.values()) {
    runningQty.set(p.id, p.qty_on_hand_milli);
    runningAvg.set(p.id, p.avg_cost_paisa);
  }

  computed.forEach((line) => {
    statements.push(
      db
        .prepare(
          `INSERT INTO purchase_lines
             (id, purchase_id, product_id, qty_milli, rate_paisa, discount_paisa, line_total_paisa)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          newId('pl'),
          purchaseId,
          line.productId,
          line.qtyMilli,
          line.ratePaisa,
          line.discountPaisa,
          line.lineTotalPaisa,
        ),
    );

    const oldQty = runningQty.get(line.productId) ?? 0;
    const oldAvg = runningAvg.get(line.productId) ?? 0;
    // Cost per unit actually paid for this line, after its own discount.
    const unitCost = Math.round((line.lineTotalPaisa * MILLI) / line.qtyMilli);
    const newAvg = weightedAvgCostPaisa(oldQty, oldAvg, line.qtyMilli, unitCost);
    const newQty = oldQty + line.qtyMilli;

    runningQty.set(line.productId, newQty);
    runningAvg.set(line.productId, newAvg);

    statements.push(
      db
        .prepare(
          `UPDATE products
             SET qty_on_hand_milli = qty_on_hand_milli + ?, avg_cost_paisa = ?,
                 purchase_rate_paisa = ?, updated_at = ?
           WHERE id = ?`,
        )
        .bind(line.qtyMilli, newAvg, line.ratePaisa, now, line.productId),
    );

    statements.push(
      db
        .prepare(
          `INSERT INTO stock_movements
             (id, product_id, movement_date, type, qty_change_milli, unit_cost_paisa,
              doc_type, doc_id, balance_after_milli, created_at)
           VALUES (?, ?, ?, 'purchase', ?, ?, 'purchase', ?, ?, ?)`,
        )
        .bind(
          newId('sm'),
          line.productId,
          input.docDate,
          line.qtyMilli,
          unitCost,
          purchaseId,
          newQty,
          now,
        ),
    );
  });

  // Ledger: Dr Inventory (total) / Cr Supplier (payable) / Cr Cash, Cr Bank
  const ledgerLines: LedgerLine[] = [
    { accountType: 'inventory', accountId: null, debitPaisa: total, memo: purchaseNo },
  ];
  if (payable > 0) {
    ledgerLines.push({
      accountType: 'supplier',
      accountId: input.companyId,
      creditPaisa: payable,
      memo: `Payable to ${company.name}`,
    });
  }
  if (paidCash > 0) {
    ledgerLines.push({
      accountType: 'cash' as const,
      accountId: input.cashAccountId!,
      creditPaisa: paidCash,
      memo: 'Paid cash',
    });
  }
  if (paidBank > 0) {
    ledgerLines.push({
      accountType: 'cash' as const,
      accountId: input.bankAccountId!,
      creditPaisa: paidBank,
      memo: 'Paid by bank',
    });
  }

  statements.push(
    ...ledgerInsertStatements(
      db,
      buildLedgerRows({
        idFor: () => newId('le'),
        entryDate: input.docDate,
        docType: 'purchase',
        docId: purchaseId,
        lines: ledgerLines,
        now,
      }),
    ),
  );

  statements.push(
    db
      .prepare(
        `INSERT INTO audit_log (id, at, user_id, action, entity_type, entity_id, detail_json)
         VALUES (?, ?, ?, 'create', 'purchase', ?, ?)`,
      )
      .bind(
        newId('al'),
        now,
        input.userId ?? null,
        purchaseId,
        JSON.stringify({ purchaseNo, total, payable }),
      ),
  );

  try {
    await db.batch(statements);
  } catch (err) {
    if (idempotencyKey && isIdempotencyCollision(err, 'uq_purchase_idem')) {
      const existing = await findPostedPurchase(db, idempotencyKey);
      if (existing) return { ok: true, purchase: existing, replayed: true };
    }
    if (isGuardFailure(err)) {
      return { ok: false, error: 'A business rule blocked this purchase', code: 'guard' };
    }
    throw err;
  }

  return { ok: true, purchase: { id: purchaseId, purchaseNo, totalPaisa: total, payablePaisa: payable } };
}

async function findPostedPurchase(db: D1Database, key: string): Promise<PostedPurchase | null> {
  const row = await db
    .prepare(
      `SELECT id, purchase_no, total_paisa, payable_paisa FROM purchases WHERE idempotency_key = ?`,
    )
    .bind(key)
    .first<{ id: string; purchase_no: string; total_paisa: number; payable_paisa: number }>();
  if (!row) return null;
  return {
    id: row.id,
    purchaseNo: row.purchase_no,
    totalPaisa: row.total_paisa,
    payablePaisa: row.payable_paisa,
  };
}

/**
 * Purchase return to the company (damaged or wrong item).
 * Stock down, and the value goes either against the payable or back as cash.
 */
export async function postPurchaseReturn(
  db: D1Database,
  input: {
    docDate: string;
    companyId: string;
    purchaseId?: string;
    lines: PurchaseLineInput[];
    refundCashPaisa?: number;
    refundBankPaisa?: number;
    cashAccountId?: string;
    bankAccountId?: string;
    reason: string;
    userId?: string;
  },
): Promise<{ ok: true; returnNo: string } | { ok: false; error: string }> {
  if (!input.reason || input.reason.trim().length < 3) {
    return { ok: false, error: 'A reason is required for a purchase return' };
  }
  if (!input.lines?.length) return { ok: false, error: 'Nothing to return' };

  const productIds = [...new Set(input.lines.map((l) => l.productId))];
  const found = await db
    .prepare(
      `SELECT id, qty_on_hand_milli FROM products
       WHERE id IN (${productIds.map(() => '?').join(', ')})`,
    )
    .bind(...productIds)
    .all<{ id: string; qty_on_hand_milli: number }>();
  const stock = new Map((found.results ?? []).map((r) => [r.id, r.qty_on_hand_milli]));

  const now = new Date().toISOString();
  const returnId = newId('pret');
  const { docNo: returnNo } = await allocateDocNo(db, 'purchase_return', input.docDate);

  let total = 0;
  const computed = input.lines.map((line) => {
    const lineTotal = lineTotalPaisa(line.qtyMilli, line.ratePaisa, line.discountPaisa ?? 0);
    total += lineTotal;
    return { ...line, lineTotalPaisa: lineTotal };
  });

  const refundCash = input.refundCashPaisa ?? 0;
  const refundBank = input.refundBankPaisa ?? 0;
  if (refundCash + refundBank > total) {
    return { ok: false, error: 'Refund exceeds the return value' };
  }
  const payableReduction = total - refundCash - refundBank;

  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO purchase_returns
           (id, return_no, doc_date, company_id, purchase_id, total_paisa,
            refund_cash_paisa, refund_bank_paisa, payable_reduction_paisa, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        returnId,
        returnNo,
        input.docDate,
        input.companyId,
        input.purchaseId ?? null,
        total,
        refundCash,
        refundBank,
        payableReduction,
        input.reason,
        now,
      ),
  ];

  for (const line of computed) {
    statements.push(
      db
        .prepare(
          `INSERT INTO purchase_return_lines
             (id, return_id, product_id, qty_milli, rate_paisa, line_total_paisa)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(newId('prl'), returnId, line.productId, line.qtyMilli, line.ratePaisa, line.lineTotalPaisa),
    );

    const after = (stock.get(line.productId) ?? 0) - line.qtyMilli;
    statements.push(
      db
        .prepare(
          `UPDATE products SET qty_on_hand_milli = qty_on_hand_milli - ?, updated_at = ?
           WHERE id = ? AND qty_on_hand_milli >= ?`,
        )
        .bind(line.qtyMilli, now, line.productId, line.qtyMilli),
    );
    statements.push(
      db
        .prepare(
          `INSERT INTO stock_movements
             (id, product_id, movement_date, type, qty_change_milli, unit_cost_paisa,
              doc_type, doc_id, balance_after_milli, note, created_at)
           VALUES (?, ?, ?, 'purchase_return', ?, ?, 'purchase_return', ?, ?, ?, ?)`,
        )
        .bind(
          newId('sm'),
          line.productId,
          input.docDate,
          -line.qtyMilli,
          line.ratePaisa,
          returnId,
          after,
          input.reason,
          now,
        ),
    );
  }

  const ledgerLines: LedgerLine[] = [
    { accountType: 'inventory', accountId: null, creditPaisa: total, memo: `Return ${returnNo}` },
  ];
  if (payableReduction > 0) {
    ledgerLines.push({
      accountType: 'supplier',
      accountId: input.companyId,
      debitPaisa: payableReduction,
      memo: 'Payable reduced',
    });
  }
  if (refundCash > 0) {
    ledgerLines.push({
      accountType: 'cash' as const,
      accountId: input.cashAccountId ?? 'ca_counter',
      debitPaisa: refundCash,
      memo: 'Refund received',
    });
  }
  if (refundBank > 0) {
    ledgerLines.push({
      accountType: 'cash' as const,
      accountId: input.bankAccountId ?? 'ca_bank',
      debitPaisa: refundBank,
      memo: 'Refund received',
    });
  }

  statements.push(
    ...ledgerInsertStatements(
      db,
      buildLedgerRows({
        idFor: () => newId('le'),
        entryDate: input.docDate,
        docType: 'purchase_return',
        docId: returnId,
        lines: ledgerLines,
        now,
      }),
    ),
  );

  await db.batch(statements);
  return { ok: true, returnNo };
}

/** Payment to a company: reduces the payable. */
export async function postSupplierPayment(
  db: D1Database,
  input: {
    docDate: string;
    companyId: string;
    amountPaisa: number;
    mode: 'cash' | 'bank' | 'cheque';
    cashAccountId: string;
    reference?: string;
    notes?: string;
    userId?: string;
    idempotencyKey?: string;
  },
): Promise<{ ok: true; paymentNo: string } | { ok: false; error: string }> {
  if (!Number.isInteger(input.amountPaisa) || input.amountPaisa <= 0) {
    return { ok: false, error: 'Payment must be greater than zero' };
  }

  const now = new Date().toISOString();
  const paymentId = newId('spay');
  const { docNo: paymentNo } = await allocateDocNo(db, 'payment', input.docDate);

  const ledgerRows = buildLedgerRows({
    idFor: () => newId('le'),
    entryDate: input.docDate,
    docType: 'payment',
    docId: paymentId,
    lines: [
      {
        accountType: 'supplier',
        accountId: input.companyId,
        debitPaisa: input.amountPaisa,
        memo: `Paid ${paymentNo}`,
      },
      {
        accountType: 'cash',
        accountId: input.cashAccountId,
        creditPaisa: input.amountPaisa,
        memo: `Paid to company (${input.mode})`,
      },
    ],
    now,
  });

  await db.batch([
    db
      .prepare(
        `INSERT INTO supplier_payments
           (id, payment_no, doc_date, company_id, amount_paisa, mode, cash_account_id,
            reference, notes, created_at, idempotency_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        paymentId,
        paymentNo,
        input.docDate,
        input.companyId,
        input.amountPaisa,
        input.mode,
        input.cashAccountId,
        input.reference ?? null,
        input.notes ?? null,
        now,
        normaliseIdempotencyKey(input.idempotencyKey),
      ),
    ...ledgerInsertStatements(db, ledgerRows),
    db
      .prepare(
        `INSERT INTO audit_log (id, at, user_id, action, entity_type, entity_id, detail_json)
         VALUES (?, ?, ?, 'create', 'supplier_payment', ?, ?)`,
      )
      .bind(newId('al'), now, input.userId ?? null, paymentId, JSON.stringify({ paymentNo })),
  ]);

  return { ok: true, paymentNo };
}
