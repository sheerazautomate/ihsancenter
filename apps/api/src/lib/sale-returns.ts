import { newId } from './ids';
import { buildLedgerRows, ledgerInsertStatements, type LedgerLine } from './ledger';
import { allocateDocNo } from './numbering';
import { lineTotalPaisa } from './money';
import { isGuardFailure } from './guard';

/**
 * Goods a customer brings back.
 *
 * The mirror of a purchase return, with one difference that matters: what the shop
 * gives back can be **cash**, or a **credit note** against what the farmer owes.
 * The split is decided by whether he still has an outstanding balance:
 *
 *   - He owes more than the return is worth  -> credit note, his udhaar shrinks.
 *   - He owes less (or nothing)              -> the shop has to hand money back.
 *
 * Posting a credit note for somebody whose account is already clear would leave a
 * negative balance -- the shop "owing" a customer with no document to explain it.
 * That is why the caller states the split and this function refuses an impossible
 * one rather than guessing.
 */

export interface SaleReturnLineInput {
  productId: string;
  qtyMilli: number;
  ratePaisa: number;
  discountPaisa?: number;
}

export interface SaleReturnInput {
  docDate: string;
  customerId: string;
  invoiceId: string;
  lines: SaleReturnLineInput[];
  refundCashPaisa?: number;
  refundBankPaisa?: number;
  creditNotePaisa?: number;
  cashAccountId?: string;
  bankAccountId?: string;
  reason: string;
  userId?: string;
  idempotencyKey?: string;
}

export type SaleReturnResult =
  | {
      ok: true;
      returnNo: string;
      returnId: string;
      totalPaisa: number;
      refundCashPaisa: number;
      refundBankPaisa: number;
      creditNotePaisa: number;
    }
  | { ok: false; error: string; conflict?: true };

export async function postSaleReturn(db: D1Database, input: SaleReturnInput): Promise<SaleReturnResult> {
  if (!input.reason || input.reason.trim().length < 3) {
    return { ok: false, error: 'A reason is required — the shop has to be able to explain a return later' };
  }
  if (!input.lines?.length) return { ok: false, error: 'Nothing to return' };

  const customer = await db
    .prepare(`SELECT id, name, is_active FROM customers WHERE id = ?`)
    .bind(input.customerId)
    .first<{ id: string; name: string; is_active: number }>();
  if (!customer) return { ok: false, error: 'Customer not found' };
  if (customer.is_active !== 1) return { ok: false, error: 'This customer is inactive' };

  // The bill being reversed. It must exist and belong to the stated customer.
  const invoice = await db
    .prepare(`SELECT id, invoice_no, doc_date, status, customer_id FROM sales_invoices WHERE id = ?`)
    .bind(input.invoiceId)
    .first<{
      id: string;
      invoice_no: string;
      doc_date: string;
      status: string;
      customer_id: string;
    }>();

  if (!invoice) return { ok: false, error: 'Invoice not found' };
  if (invoice.customer_id !== input.customerId) {
    return { ok: false, error: 'That invoice belongs to a different customer' };
  }
  if (invoice.status === 'void') {
    return { ok: false, error: 'That invoice was voided, so there is nothing to return against it' };
  }

  const productIds = [...new Set(input.lines.map((l) => l.productId))];
  const found = await db
    .prepare(
      `SELECT id, name, qty_on_hand_milli, avg_cost_paisa FROM products
       WHERE id IN (${productIds.map(() => '?').join(', ')})`,
    )
    .bind(...productIds)
    .all<{ id: string; name: string; qty_on_hand_milli: number; avg_cost_paisa: number }>();
  const products = new Map((found.results ?? []).map((p) => [p.id, p]));

  if (products.size !== productIds.length) {
    return { ok: false, error: 'One of the products does not exist' };
  }

  // Never return more than was sold on that invoice, per product. Without this a
  // mistyped quantity can create stock that never existed and a refund bigger
  // than the bill.
  //
  // This is not optional. A return that names no bill cannot be capped at all --
  // nothing says what left the shop -- so generic returns are refused at the
  // schema. A farmer who has lost his slip is served by looking the bill up on
  // screen, not by booking stock back that was never sold.
  {
    const sold = await db
      .prepare(
        `SELECT product_id, SUM(qty_milli) AS sold_milli
         FROM sales_invoice_lines WHERE invoice_id = ? GROUP BY product_id`,
      )
      .bind(invoice.id)
      .all<{ product_id: string; sold_milli: number }>();

    const already = await db
      .prepare(
        `SELECT l.product_id, SUM(l.qty_milli) AS returned_milli
         FROM sale_return_lines l JOIN sale_returns r ON r.id = l.return_id
         WHERE r.invoice_id = ? AND r.status = 'open'
         GROUP BY l.product_id`,
      )
      .bind(invoice.id)
      .all<{ product_id: string; returned_milli: number }>();

    const soldMap = new Map((sold.results ?? []).map((r) => [r.product_id, r.sold_milli]));
    const returnedMap = new Map((already.results ?? []).map((r) => [r.product_id, r.returned_milli]));

    const wanted = new Map<string, number>();
    for (const line of input.lines) {
      wanted.set(line.productId, (wanted.get(line.productId) ?? 0) + line.qtyMilli);
    }

    for (const [productId, qty] of wanted) {
      const soldQty = soldMap.get(productId) ?? 0;
      const returnedQty = returnedMap.get(productId) ?? 0;
      if (soldQty === 0) {
        const name = products.get(productId)?.name ?? productId;
        return { ok: false, error: `${name} was not on invoice ${invoice.invoice_no}` };
      }
      if (qty > soldQty - returnedQty) {
        const name = products.get(productId)?.name ?? productId;
        return {
          ok: false,
          error: `Only ${(soldQty - returnedQty) / 1000} unit(s) of ${name} can still be returned from ${invoice.invoice_no}`,
        };
      }
    }
  }

  // Value the return. The cost credited back to inventory is the average cost the
  // product carries now, negative quantities guarded per product.
  let total = 0;
  let costTotal = 0;
  const computed = input.lines.map((line) => {
    const lineTotal = lineTotalPaisa(line.qtyMilli, line.ratePaisa, line.discountPaisa ?? 0);
    const product = products.get(line.productId)!;
    // round(qty * avgcost / 1000) in integer paisa, the same shape the sale used.
    const costPaisa = Math.round((line.qtyMilli * product.avg_cost_paisa) / 1000);
    total += lineTotal;
    costTotal += costPaisa;
    return { ...line, lineTotalPaisa: lineTotal, costPaisa };
  });

  const refundCash = input.refundCashPaisa ?? 0;
  const refundBank = input.refundBankPaisa ?? 0;
  const creditNote = input.creditNotePaisa ?? 0;

  if ([refundCash, refundBank, creditNote].some((n) => !Number.isInteger(n) || n < 0)) {
    return { ok: false, error: 'Refund amounts must be whole paisa and not negative' };
  }
  if (refundCash + refundBank + creditNote !== total) {
    return {
      ok: false,
      error: `The refund (${(refundCash + refundBank + creditNote) / 100}) must equal the return value (${total / 100})`,
    };
  }
  if (refundCash > 0 && !input.cashAccountId) {
    return { ok: false, error: 'A cash account is required when refunding cash' };
  }

  // A credit note may not push the customer's balance below zero. That is the
  // "he paid already, so give the money back" case, and it has to be refunded as
  // cash or bank instead.
  if (creditNote > 0) {
    const balance = await db
      .prepare(
        `SELECT COALESCE(SUM(debit_paisa - credit_paisa), 0) AS owedPaisa
         FROM ledger_entries WHERE account_type = 'customer' AND account_id = ?`,
      )
      .bind(input.customerId)
      .first<{ owedPaisa: number }>();
    const owed = balance?.owedPaisa ?? 0;
    if (creditNote > owed) {
      return {
        ok: false,
        error:
          owed <= 0
            ? 'This customer owes nothing, so there is no balance to credit. Refund the money instead.'
            : `They only owe ${owed / 100}; a credit note of ${creditNote / 100} would overpay the account. Refund the difference.`,
      };
    }
  }

  const now = new Date().toISOString();
  const returnId = newId('sret');
  const { docNo: returnNo } = await allocateDocNo(db, 'sale_return', input.docDate);

  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO sale_returns
           (id, return_no, doc_date, customer_id, invoice_id, total_paisa, cost_total_paisa,
            refund_cash_paisa, refund_bank_paisa, credit_note_paisa, cash_account_id,
            bank_account_id, reason, created_at, idempotency_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        returnId,
        returnNo,
        input.docDate,
        input.customerId,
        invoice.id,
        total,
        costTotal,
        refundCash,
        refundBank,
        creditNote,
        refundCash > 0 ? input.cashAccountId! : null,
        refundBank > 0 ? (input.bankAccountId ?? 'ca_bank') : null,
        input.reason,
        now,
        input.idempotencyKey ?? null,
      ),
  ];

  for (const line of computed) {
    statements.push(
      db
        .prepare(
          `INSERT INTO sale_return_lines
             (id, return_id, product_id, qty_milli, rate_paisa, discount_paisa,
              line_total_paisa, cost_paisa)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          newId('srl'),
          returnId,
          line.productId,
          line.qtyMilli,
          line.ratePaisa,
          line.discountPaisa ?? 0,
          line.lineTotalPaisa,
          line.costPaisa,
        ),
    );

    // Stock back up. The returned goods are the ones that left, at their average
    // cost, so the inventory value returns to where it was.
    statements.push(
      db
        .prepare(
          `UPDATE products SET qty_on_hand_milli = qty_on_hand_milli + ?, updated_at = ?
           WHERE id = ?`,
        )
        .bind(line.qtyMilli, now, line.productId),
    );

    const product = products.get(line.productId)!;
    statements.push(
      db
        .prepare(
          `INSERT INTO stock_movements
             (id, product_id, movement_date, type, qty_change_milli, unit_cost_paisa,
              doc_type, doc_id, balance_after_milli, note, created_at)
           VALUES (?, ?, ?, 'sale_return', ?, ?, 'sale_return', ?, ?, ?, ?)`,
        )
        .bind(
          newId('sm'),
          line.productId,
          input.docDate,
          line.qtyMilli,
          product.avg_cost_paisa,
          returnId,
          product.qty_on_hand_milli + line.qtyMilli,
          input.reason,
          now,
        ),
    );
  }

  // Ledger, balanced by construction: refunds + credit note === total.
  const ledgerLines: LedgerLine[] = [
    { accountType: 'sale_return', accountId: null, debitPaisa: total, memo: `Return ${returnNo}` },
  ];

  if (refundCash > 0) {
    ledgerLines.push({
      accountType: 'cash',
      accountId: input.cashAccountId!,
      creditPaisa: refundCash,
      memo: 'Cash refunded to customer',
    });
  }
  if (refundBank > 0) {
    ledgerLines.push({
      accountType: 'cash',
      accountId: input.bankAccountId ?? 'ca_bank',
      creditPaisa: refundBank,
      memo: 'Bank refund to customer',
    });
  }
  if (creditNote > 0) {
    ledgerLines.push({
      accountType: 'customer',
      accountId: input.customerId,
      creditPaisa: creditNote,
      memo: `Credit note ${returnNo}`,
    });
  }
  if (costTotal > 0) {
    // The reverse of the sale: inventory comes back, the cost of goods sold goes
    // away. Without this pair the profit on a returned sale would be understated
    // by the cost of the goods that came back.
    ledgerLines.push(
      {
        accountType: 'inventory',
        accountId: null,
        debitPaisa: costTotal,
        memo: 'Inventory returned',
      },
      {
        accountType: 'cogs',
        accountId: null,
        creditPaisa: costTotal,
        memo: 'Cost of goods returned',
      },
    );
  }

  statements.push(
    ...ledgerInsertStatements(
      db,
      buildLedgerRows({
        idFor: () => newId('le'),
        entryDate: input.docDate,
        docType: 'sale_return',
        docId: returnId,
        lines: ledgerLines,
        now,
      }),
    ),
  );

  statements.push(
    db
      .prepare(
        `INSERT INTO audit_log (id, at, user_id, action, entity_type, entity_id, detail_json)
         VALUES (?, ?, ?, 'create', 'sale_return', ?, ?)`,
      )
      .bind(
        newId('al'),
        now,
        input.userId ?? null,
        returnId,
        JSON.stringify({ returnNo, total, creditNote, refundCash, refundBank, invoiceId: invoice.id }),
      ),
  );

  try {
    await db.batch(statements);
  } catch (err) {
    // The UNIQUE index on idempotency_key makes a double-tap harmless.
    const message = err instanceof Error ? err.message : String(err);
    if (input.idempotencyKey && message.includes('UNIQUE') && message.includes('idempotency_key')) {
      const existing = await db
        .prepare(
          `SELECT id, return_no, invoice_id, total_paisa, refund_cash_paisa,
                  refund_bank_paisa, credit_note_paisa
           FROM sale_returns WHERE idempotency_key = ?`,
        )
        .bind(input.idempotencyKey)
        .first<{
          id: string;
          return_no: string;
          invoice_id: string;
          total_paisa: number;
          refund_cash_paisa: number;
          refund_bank_paisa: number;
          credit_note_paisa: number;
        }>();

      // Report what was actually stored, never what this attempt asked for.
      // Echoing the new amounts under the old number would show the shop a
      // Rs 20,000 return whose document says Rs 7,500.
      if (existing && existing.invoice_id === invoice.id) {
        return {
          ok: true,
          returnNo: existing.return_no,
          returnId: existing.id,
          totalPaisa: existing.total_paisa,
          refundCashPaisa: existing.refund_cash_paisa,
          refundBankPaisa: existing.refund_bank_paisa,
          creditNotePaisa: existing.credit_note_paisa,
        };
      }

      // Same key, different bill: the second return was never written. Saying
      // "ok" would tell the counter it was.
      if (existing) {
        return {
          ok: false,
          error: `That request key already belongs to ${existing.return_no}. Try the return again.`,
          conflict: true,
        };
      }
    }
    if (isGuardFailure(err)) {
      return { ok: false, error: 'A business rule blocked this return' };
    }
    throw err;
  }

  return {
    ok: true,
    returnNo,
    returnId,
    totalPaisa: total,
    refundCashPaisa: refundCash,
    refundBankPaisa: refundBank,
    creditNotePaisa: creditNote,
  };
}
