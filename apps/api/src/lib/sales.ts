/**
 * Posting a sale.
 *
 * This is the money path, so it is deliberately explicit: read what we need,
 * validate it, build the ENTIRE list of prepared statements, then execute as one
 * atomic D1 batch. Invariants that depend on current data (credit limit, credit
 * hold, stock) are enforced by guards INSIDE the batch, never by a
 * check-then-write in application code.
 *
 * A sale of Rs 10,000 (cost Rs 7,000) paid Rs 4,000 cash + Rs 6,000 udhaar:
 *
 *   Dr Cash            4,000      Cr Sales        10,000
 *   Dr Receivable      6,000
 *   Dr COGS            7,000      Cr Inventory     7,000
 */

import { lineTotalPaisa, MILLI } from './money';
import { newId } from './ids';
import { buildLedgerRows, ledgerInsertStatements } from './ledger';
import {
  creditHoldGuard,
  creditLimitGuard,
  diagnoseSaleFailure,
  isGuardFailure,
  stockGuard,
  withGuards,
} from './guard';
import { allocateDocNo } from './numbering';

export interface SaleLineInput {
  productId: string;
  qtyMilli: number;
  ratePaisa: number;
  discountPaisa?: number;
}

export interface SaleInput {
  docDate: string;
  customerId: string;
  lines: SaleLineInput[];
  invoiceDiscountPaisa?: number;
  paidCashPaisa?: number;
  paidBankPaisa?: number;
  cashAccountId?: string;
  bankAccountId?: string;
  notes?: string;
  /** Manager override for the credit limit / credit hold guards. Always audited. */
  overrideCredit?: boolean;
  overrideReason?: string;
  allowNegativeStock?: boolean;
  userId?: string;
}

export interface PostedSale {
  id: string;
  invoiceNo: string;
  totalPaisa: number;
  creditPaisa: number;
  costTotalPaisa: number;
}

export type PostSaleResult =
  | { ok: true; sale: PostedSale }
  | { ok: false; error: string; code?: string };

interface ProductRow {
  id: string;
  name: string;
  qty_on_hand_milli: number;
  avg_cost_paisa: number;
  sale_rate_paisa: number;
  is_active: number;
}

export async function postSale(db: D1Database, input: SaleInput): Promise<PostSaleResult> {
  // ---------- 1. validate input ----------
  if (!input.lines || input.lines.length === 0) {
    return { ok: false, error: 'A sale needs at least one line' };
  }
  for (const line of input.lines) {
    if (!Number.isInteger(line.qtyMilli) || line.qtyMilli <= 0) {
      return { ok: false, error: `Invalid quantity on a line (${line.qtyMilli})` };
    }
    if (!Number.isInteger(line.ratePaisa) || line.ratePaisa < 0) {
      return { ok: false, error: `Invalid rate on a line (${line.ratePaisa})` };
    }
  }

  // ---------- 2. read the products we are selling ----------
  const productIds = [...new Set(input.lines.map((l) => l.productId))];
  const placeholders = productIds.map(() => '?').join(', ');
  const productResult = await db
    .prepare(
      `SELECT id, name, qty_on_hand_milli, avg_cost_paisa, sale_rate_paisa, is_active
       FROM products WHERE id IN (${placeholders})`,
    )
    .bind(...productIds)
    .all<ProductRow>();

  const products = new Map<string, ProductRow>();
  for (const row of productResult.results ?? []) products.set(row.id, row);

  for (const id of productIds) {
    const p = products.get(id);
    if (!p) return { ok: false, error: `Product not found: ${id}` };
    if (p.is_active !== 1) return { ok: false, error: `Product is inactive: ${p.name}` };
  }

  // ---------- 3. customer ----------
  const customer = await db
    .prepare(`SELECT id, name, type FROM customers WHERE id = ? AND is_active = 1`)
    .bind(input.customerId)
    .first<{ id: string; name: string; type: string }>();
  if (!customer) return { ok: false, error: 'Customer not found or inactive' };

  // ---------- 4. compute totals ----------
  const now = new Date().toISOString();
  const invoiceId = newId('inv');

  let subtotal = 0;
  let costTotal = 0;
  type ComputedLine =
    | { ok: true; productId: string; qtyMilli: number; ratePaisa: number; discountPaisa: number;
        lineTotalPaisa: number; costPaisa: number; product: ProductRow }
    | { ok: false; error: string };

  const computedLines: ComputedLine[] = input.lines.map((line, index) => {
    const product = products.get(line.productId)!;
    const discount = line.discountPaisa ?? 0;
    const lineTotal = lineTotalPaisa(line.qtyMilli, line.ratePaisa, discount);
    if (lineTotal < 0) {
      return { ok: false, error: `Discount exceeds line value on ${product.name} (line ${index + 1})` };
    }
    // Cost is snapshotted from the weighted average at sale time and stored on the
    // line, so a reprint next year still shows the margin that was actually made.
    const lineCost = Math.floor((line.qtyMilli * product.avg_cost_paisa + MILLI / 2) / MILLI);
    subtotal += lineTotal;
    costTotal += lineCost;
    return {
      ok: true as const,
      productId: line.productId,
      qtyMilli: line.qtyMilli,
      ratePaisa: line.ratePaisa,
      discountPaisa: discount,
      lineTotalPaisa: lineTotal,
      costPaisa: lineCost,
      product,
    };
  });

  const badLine = computedLines.find((l) => !l.ok);
  if (badLine && !badLine.ok) return { ok: false, error: badLine.error };

  const invoiceDiscount = input.invoiceDiscountPaisa ?? 0;
  const total = subtotal - invoiceDiscount;
  if (total < 0) return { ok: false, error: 'Invoice discount exceeds the subtotal' };

  const paidCash = input.paidCashPaisa ?? 0;
  const paidBank = input.paidBankPaisa ?? 0;
  if (paidCash < 0 || paidBank < 0) return { ok: false, error: 'Payments cannot be negative' };
  if (paidCash + paidBank > total) {
    return { ok: false, error: `Payment (${paidCash + paidBank}) exceeds invoice total (${total})` };
  }
  const credit = total - paidCash - paidBank;

  if (credit > 0 && customer.type === 'walkin') {
    return { ok: false, error: 'Walk-in customers cannot be given credit. Select a customer.' };
  }
  if (paidCash > 0 && !input.cashAccountId) {
    return { ok: false, error: 'A cash account is required when cash is received' };
  }
  if (paidBank > 0 && !input.bankAccountId) {
    return { ok: false, error: 'A bank account is required when bank payment is received' };
  }

  // ---------- 5. allocate the invoice number (before the batch) ----------
  const { docNo: invoiceNo } = await allocateDocNo(db, 'invoice', input.docDate);

  // ---------- 6. build the statements ----------
  const statements: D1PreparedStatement[] = [];

  statements.push(
    db
      .prepare(
        `INSERT INTO sales_invoices
           (id, invoice_no, doc_date, customer_id, subtotal_paisa, discount_paisa,
            total_paisa, paid_cash_paisa, paid_bank_paisa, credit_paisa,
            cost_total_paisa, cash_account_id, bank_account_id, notes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        invoiceId,
        invoiceNo,
        input.docDate,
        input.customerId,
        subtotal,
        invoiceDiscount,
        total,
        paidCash,
        paidBank,
        credit,
        costTotal,
        input.cashAccountId ?? null,
        input.bankAccountId ?? null,
        input.notes ?? null,
        now,
      ),
  );

  // Track per-product sold quantity so two lines of the same product cannot
  // jointly oversell.
  const soldSoFar = new Map<string, number>();

  computedLines.forEach((line, index) => {
    if (!line.ok) return;
    const previouslySold = soldSoFar.get(line.productId) ?? 0;

    statements.push(
      db
        .prepare(
          `INSERT INTO sales_invoice_lines
             (id, invoice_id, product_id, qty_milli, rate_paisa, discount_paisa,
              line_total_paisa, cost_paisa, sort_order)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          newId('sl'),
          invoiceId,
          line.productId,
          line.qtyMilli,
          line.ratePaisa,
          line.discountPaisa,
          line.lineTotalPaisa,
          line.costPaisa,
          index,
        ),
    );

    // Stock down. The WHERE clause prevents a negative quantity in the row, but
    // note that matching zero rows does NOT fail a batch -- the stock guard below
    // is what actually aborts the transaction.
    statements.push(
      db
        .prepare(
          `UPDATE products SET qty_on_hand_milli = qty_on_hand_milli - ?, updated_at = ?
           WHERE id = ? AND qty_on_hand_milli >= ?`,
        )
        .bind(line.qtyMilli, now, line.productId, line.qtyMilli + previouslySold),
    );

    statements.push(
      db
        .prepare(
          `INSERT INTO stock_movements
             (id, product_id, movement_date, type, qty_change_milli, unit_cost_paisa,
              doc_type, doc_id, balance_after_milli, created_at)
           VALUES (?, ?, ?, 'sale', ?, ?, 'sale', ?, ?, ?)`,
        )
        .bind(
          newId('sm'),
          line.productId,
          input.docDate,
          -line.qtyMilli,
          line.product.avg_cost_paisa,
          invoiceId,
          line.product.qty_on_hand_milli - line.qtyMilli - previouslySold,
          now,
        ),
    );

    soldSoFar.set(line.productId, previouslySold + line.qtyMilli);
  });

  // Ledger: balanced by construction, because cash + bank + credit === total
  const ledgerLines = [];
  if (paidCash > 0) {
    ledgerLines.push({
      accountType: 'cash' as const,
      accountId: input.cashAccountId!,
      debitPaisa: paidCash,
      memo: 'Cash received',
    });
  }
  if (paidBank > 0) {
    ledgerLines.push({
      accountType: 'cash' as const,
      accountId: input.bankAccountId!,
      debitPaisa: paidBank,
      memo: 'Bank received',
    });
  }
  if (credit > 0) {
    ledgerLines.push({
      accountType: 'customer' as const,
      accountId: input.customerId,
      debitPaisa: credit,
      memo: 'On credit (udhaar)',
    });
  }
  ledgerLines.push({
    accountType: 'sales' as const,
    accountId: null,
    creditPaisa: total,
    memo: invoiceNo,
  });
  if (costTotal > 0) {
    ledgerLines.push(
      {
        accountType: 'cogs' as const,
        accountId: null,
        debitPaisa: costTotal,
        memo: 'Cost of goods sold',
      },
      {
        accountType: 'inventory' as const,
        accountId: null,
        creditPaisa: costTotal,
        memo: 'Inventory relieved',
      },
    );
  }

  const ledgerRows = buildLedgerRows({
    idFor: () => newId('le'),
    entryDate: input.docDate,
    docType: 'sale',
    docId: invoiceId,
    lines: ledgerLines,
    now,
  });
  statements.push(...ledgerInsertStatements(db, ledgerRows));

  // Audit. Overrides are always recorded, with the reason.
  statements.push(
    db
      .prepare(
        `INSERT INTO audit_log (id, at, user_id, action, entity_type, entity_id, detail_json)
         VALUES (?, ?, ?, ?, 'invoice', ?, ?)`,
      )
      .bind(
        newId('al'),
        now,
        input.userId ?? null,
        input.overrideCredit ? 'override' : 'create',
        invoiceId,
        JSON.stringify({ invoiceNo, total, credit, overrideReason: input.overrideReason ?? null }),
      ),
  );

  // ---------- 7. guards, then one atomic batch ----------
  const guarded = withGuards(db, statements, [
    creditLimitGuard({
      customerId: input.customerId,
      newCreditPaisa: credit,
      override: input.overrideCredit ?? false,
    }),
    creditHoldGuard({
      customerId: input.customerId,
      newCreditPaisa: credit,
      override: input.overrideCredit ?? false,
    }),
    ...computedLines.map((line, index) =>
      !line.ok
        ? null
        : stockGuard({
            productId: line.productId,
            qtyMilli: line.qtyMilli,
            // quantity of this product sold by EARLIER lines of the same invoice
            alreadySoldMilli: computedLines
              .slice(0, index)
              .filter((l): l is Extract<ComputedLine, { ok: true }> => l.ok && l.productId === line.productId)
              .reduce((sum, l) => sum + l.qtyMilli, 0),
            allowNegativeStock: input.allowNegativeStock ?? false,
            override: false,
          }),
    ),
  ]);

  try {
    await db.batch(guarded);
  } catch (err) {
    // The batch rolled back, so the database is untouched: re-reading it now tells
    // us truthfully which invariant blocked the sale.
    if (isGuardFailure(err)) {
      const diagnosis = await diagnoseSaleFailure(db, {
        customerId: input.customerId,
        creditPaisa: credit,
        lines: computedLines
          .filter((l): l is Extract<ComputedLine, { ok: true }> => l.ok)
          .map((l) => ({ productId: l.productId, productName: l.product.name, qtyMilli: l.qtyMilli })),
      });
      return { ok: false, error: diagnosis.detail, code: diagnosis.code };
    }
    throw err;
  }

  return {
    ok: true,
    sale: {
      id: invoiceId,
      invoiceNo,
      totalPaisa: total,
      creditPaisa: credit,
      costTotalPaisa: costTotal,
    },
  };
}

/**
 * Void a sale. Nothing is deleted: reversing ledger rows and reversing stock
 * movements are inserted, and the document is marked void with a reason. The
 * original stays visible in every ledger so a voided bill still explains itself
 * a year later.
 */
export async function voidSale(
  db: D1Database,
  args: { invoiceId: string; reason: string; userId?: string },
): Promise<PostSaleResult> {
  if (!args.reason || args.reason.trim().length < 3) {
    return { ok: false, error: 'A reason is required to void an invoice' };
  }

  const invoice = await db
    .prepare(`SELECT * FROM sales_invoices WHERE id = ?`)
    .bind(args.invoiceId)
    .first<Record<string, unknown>>();
  if (!invoice) return { ok: false, error: 'Invoice not found' };
  if (invoice.status === 'void') return { ok: false, error: 'Invoice is already void' };

  const lines = await db
    .prepare(`SELECT * FROM sales_invoice_lines WHERE invoice_id = ?`)
    .bind(args.invoiceId)
    .all<Record<string, unknown>>();

  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];

  statements.push(
    db
      .prepare(`UPDATE sales_invoices SET status = 'void', void_reason = ?, voided_at = ? WHERE id = ?`)
      .bind(args.reason, now, args.invoiceId),
  );

  // Stock back up
  for (const line of lines.results ?? []) {
    const qty = Number(line.qty_milli);
    const productId = String(line.product_id);

    const balanceRow = await db
      .prepare(`SELECT qty_on_hand_milli AS q FROM products WHERE id = ?`)
      .bind(productId)
      .first<{ q: number }>();

    statements.push(
      db
        .prepare(`UPDATE products SET qty_on_hand_milli = qty_on_hand_milli + ?, updated_at = ? WHERE id = ?`)
        .bind(qty, now, productId),
    );

    statements.push(
      db
        .prepare(
          `INSERT INTO stock_movements
             (id, product_id, movement_date, type, qty_change_milli, unit_cost_paisa,
              doc_type, doc_id, balance_after_milli, note, created_at)
           VALUES (?, ?, ?, 'adjustment', ?, ?, 'void', ?, ?, ?, ?)`,
        )
        .bind(
          newId('sm'),
          productId,
          String(invoice.doc_date),
          qty,
          Number(line.cost_paisa),
          args.invoiceId,
          (balanceRow?.q ?? 0) + qty,
          `Void of ${invoice.invoice_no}`,
          now,
        ),
    );
  }

  // Reverse whatever the invoice posted
  const reversalLines = [];
  if (Number(invoice.paid_cash_paisa) > 0) {
    reversalLines.push({
      accountType: 'cash' as const,
      accountId: String(invoice.cash_account_id),
      creditPaisa: Number(invoice.paid_cash_paisa),
      memo: 'Void: cash returned',
    });
  }
  if (Number(invoice.paid_bank_paisa) > 0) {
    reversalLines.push({
      accountType: 'cash' as const,
      accountId: String(invoice.bank_account_id),
      creditPaisa: Number(invoice.paid_bank_paisa),
      memo: 'Void: bank returned',
    });
  }
  if (Number(invoice.credit_paisa) > 0) {
    reversalLines.push({
      accountType: 'customer' as const,
      accountId: String(invoice.customer_id),
      creditPaisa: Number(invoice.credit_paisa),
      memo: 'Void: credit reversed',
    });
  }
  reversalLines.push({
    accountType: 'sales' as const,
    accountId: null,
    debitPaisa: Number(invoice.total_paisa),
    memo: `Void ${invoice.invoice_no}`,
  });
  if (Number(invoice.cost_total_paisa) > 0) {
    reversalLines.push(
      {
        accountType: 'cogs' as const,
        accountId: null,
        creditPaisa: Number(invoice.cost_total_paisa),
        memo: 'Void: cogs reversed',
      },
      {
        accountType: 'inventory' as const,
        accountId: null,
        debitPaisa: Number(invoice.cost_total_paisa),
        memo: 'Void: inventory restored',
      },
    );
  }

  statements.push(
    ...ledgerInsertStatements(
      db,
      buildLedgerRows({
        idFor: () => newId('le'),
        entryDate: String(invoice.doc_date),
        docType: 'void',
        docId: args.invoiceId,
        lines: reversalLines,
        now,
      }),
    ),
  );

  statements.push(
    db
      .prepare(
        `INSERT INTO audit_log (id, at, user_id, action, entity_type, entity_id, detail_json)
         VALUES (?, ?, ?, 'void', 'invoice', ?, ?)`,
      )
      .bind(newId('al'), now, args.userId ?? null, args.invoiceId, JSON.stringify({ reason: args.reason })),
  );

  await db.batch(statements);

  return {
    ok: true,
    sale: {
      id: args.invoiceId,
      invoiceNo: String(invoice.invoice_no),
      totalPaisa: Number(invoice.total_paisa),
      creditPaisa: Number(invoice.credit_paisa),
      costTotalPaisa: Number(invoice.cost_total_paisa),
    },
  };
}
