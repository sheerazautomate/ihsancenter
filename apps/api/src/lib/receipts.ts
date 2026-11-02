/**
 * Customer receipts — collecting credit.
 *
 * A receipt is money in against a customer's outstanding balance. It is posted
 * together with its allocations to specific invoices, so aging stays truthful:
 * "31-60 days" must mean money that has genuinely been unpaid that long, which a
 * bare balance cannot tell you.
 *
 * Allocation is oldest-invoice-first by default (the only fair rule for a khata),
 * but the manager can allocate by hand.
 */

import { newId } from './ids';
import { buildLedgerRows, INVOICE_BALANCE_SQL, ledgerInsertStatements } from './ledger';
import { isGuardFailure } from './guard';
import { allocateDocNo } from './numbering';
import { isIdempotencyCollision, normaliseIdempotencyKey } from './idempotency';

export interface ReceiptInput {
  docDate: string;
  customerId: string;
  amountPaisa: number;
  mode: 'cash' | 'bank' | 'cheque';
  cashAccountId: string;
  reference?: string;
  notes?: string;
  /** Explicit invoice allocations. Omit to auto-allocate oldest-first. */
  allocations?: Array<{ invoiceId: string; amountPaisa: number }>;
  userId?: string;
  idempotencyKey?: string;
}

export interface PostedReceipt {
  id: string;
  receiptNo: string;
  amountPaisa: number;
  allocatedPaisa: number;
  /** Money received beyond what is owed — sits as a customer advance. */
  unallocatedPaisa: number;
}

export type PostReceiptResult =
  | { ok: true; receipt: PostedReceipt; replayed?: boolean }
  | { ok: false; error: string; code?: string };

export async function postReceipt(
  db: D1Database,
  input: ReceiptInput,
): Promise<PostReceiptResult> {
  const idempotencyKey = normaliseIdempotencyKey(input.idempotencyKey);

  if (idempotencyKey) {
    const existing = await findPostedReceipt(db, idempotencyKey);
    if (existing) return { ok: true, receipt: existing, replayed: true };
  }

  if (!Number.isInteger(input.amountPaisa) || input.amountPaisa <= 0) {
    return { ok: false, error: 'Amount must be greater than zero' };
  }

  const customer = await db
    .prepare(`SELECT id, name FROM customers WHERE id = ? AND is_active = 1`)
    .bind(input.customerId)
    .first<{ id: string; name: string }>();
  if (!customer) return { ok: false, error: 'Customer not found' };

  const account = await db
    .prepare(`SELECT id FROM cash_accounts WHERE id = ? AND is_active = 1`)
    .bind(input.cashAccountId)
    .first<{ id: string }>();
  if (!account) return { ok: false, error: 'Cash or bank account not found' };

  // Unpaid invoices, oldest first, with their remaining balances.
  const openInvoices = await db
    .prepare(`SELECT * FROM (${INVOICE_BALANCE_SQL}) b WHERE b.customer_id = ? AND b.bal > 0 ORDER BY b.doc_date ASC, b.id ASC`)
    .bind(input.customerId)
    .all<{ id: string; bal: number; doc_date: string; invoice_no: string }>();

  const outstanding = (openInvoices.results ?? []).reduce((sum, i) => sum + i.bal, 0);

  // ---------- decide the allocations ----------
  let allocations: Array<{ invoiceId: string; amountPaisa: number }> = [];

  if (input.allocations && input.allocations.length > 0) {
    const byId = new Map((openInvoices.results ?? []).map((i) => [i.id, i]));
    for (const alloc of input.allocations) {
      const invoice = byId.get(alloc.invoiceId);
      if (!invoice) {
        return { ok: false, error: 'One of the allocated invoices is not open for this customer' };
      }
      if (!Number.isInteger(alloc.amountPaisa) || alloc.amountPaisa <= 0) {
        return { ok: false, error: 'Allocation amounts must be greater than zero' };
      }
      if (alloc.amountPaisa > invoice.bal) {
        return {
          ok: false,
          error: `Allocation to ${invoice.invoice_no} exceeds its balance`,
        };
      }
      allocations.push(alloc);
    }
    const allocated = allocations.reduce((s, a) => s + a.amountPaisa, 0);
    if (allocated > input.amountPaisa) {
      return { ok: false, error: 'Allocations exceed the amount received' };
    }
  } else {
    // Auto-allocate oldest first, capped at the amount received.
    let remaining = input.amountPaisa;
    for (const invoice of openInvoices.results ?? []) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, invoice.bal);
      if (take > 0) {
        allocations.push({ invoiceId: invoice.id, amountPaisa: take });
        remaining -= take;
      }
    }
  }

  const allocatedPaisa = allocations.reduce((s, a) => s + a.amountPaisa, 0);
  const unallocatedPaisa = input.amountPaisa - allocatedPaisa;

  const now = new Date().toISOString();
  const receiptId = newId('rec');
  const { docNo: receiptNo } = await allocateDocNo(db, 'receipt', input.docDate);

  const statements: D1PreparedStatement[] = [];

  statements.push(
    db
      .prepare(
        `INSERT INTO customer_receipts
           (id, receipt_no, doc_date, customer_id, amount_paisa, mode, cash_account_id,
            reference, notes, created_at, idempotency_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        receiptId,
        receiptNo,
        input.docDate,
        input.customerId,
        input.amountPaisa,
        input.mode,
        input.cashAccountId,
        input.reference ?? null,
        input.notes ?? null,
        now,
        idempotencyKey,
      ),
  );

  for (const alloc of allocations) {
    statements.push(
      db
        .prepare(
          `INSERT INTO receipt_allocations (id, receipt_id, invoice_id, amount_paisa)
           VALUES (?, ?, ?, ?)`,
        )
        .bind(newId('ra'), receiptId, alloc.invoiceId, alloc.amountPaisa),
    );
  }

  // Dr Cash / Cr Receivable. The full amount is credited to the customer even if
  // only part is allocated to invoices, so the ledger balance always equals what
  // they actually owe; unallocated money simply shows as an advance.
  statements.push(
    ...ledgerInsertStatements(
      db,
      buildLedgerRows({
        idFor: () => newId('le'),
        entryDate: input.docDate,
        docType: 'receipt',
        docId: receiptId,
        lines: [
          {
            accountType: 'cash',
            accountId: input.cashAccountId,
            debitPaisa: input.amountPaisa,
            memo: `Receipt ${receiptNo} (${input.mode})`,
          },
          {
            accountType: 'customer',
            accountId: input.customerId,
            creditPaisa: input.amountPaisa,
            memo: `Received from ${customer.name}`,
          },
        ],
        now,
      }),
    ),
  );

  statements.push(
    db
      .prepare(
        `INSERT INTO audit_log (id, at, user_id, action, entity_type, entity_id, detail_json)
         VALUES (?, ?, ?, 'create', 'receipt', ?, ?)`,
      )
      .bind(
        newId('al'),
        now,
        input.userId ?? null,
        receiptId,
        JSON.stringify({ receiptNo, amount: input.amountPaisa, allocatedPaisa, unallocatedPaisa }),
      ),
  );

  try {
    await db.batch(statements);
  } catch (err) {
    if (idempotencyKey && isIdempotencyCollision(err, 'uq_receipt_idem')) {
      const existing = await findPostedReceipt(db, idempotencyKey);
      if (existing) return { ok: true, receipt: existing, replayed: true };
    }
    if (isGuardFailure(err)) {
      return { ok: false, error: 'A business rule blocked this receipt', code: 'guard' };
    }
    throw err;
  }

  return {
    ok: true,
    receipt: { id: receiptId, receiptNo, amountPaisa: input.amountPaisa, allocatedPaisa, unallocatedPaisa },
  };
}

async function findPostedReceipt(db: D1Database, key: string): Promise<PostedReceipt | null> {
  const row = await db
    .prepare(`SELECT id, receipt_no, amount_paisa FROM customer_receipts WHERE idempotency_key = ?`)
    .bind(key)
    .first<{ id: string; receipt_no: string; amount_paisa: number }>();
  if (!row) return null;

  const allocated = await db
    .prepare(`SELECT COALESCE(SUM(amount_paisa), 0) AS n FROM receipt_allocations WHERE receipt_id = ?`)
    .bind(row.id)
    .first<{ n: number }>();

  const allocatedPaisa = allocated?.n ?? 0;
  return {
    id: row.id,
    receiptNo: row.receipt_no,
    amountPaisa: row.amount_paisa,
    allocatedPaisa,
    unallocatedPaisa: row.amount_paisa - allocatedPaisa,
  };
}

/** Record an expense (rent, utilities, salaries...). Cash or bank out, expense in. */
export async function postExpense(
  db: D1Database,
  input: {
    docDate: string;
    categoryId: string;
    amountPaisa: number;
    cashAccountId: string;
    payee?: string;
    notes?: string;
    userId?: string;
    idempotencyKey?: string;
  },
): Promise<{ ok: true; expenseId: string } | { ok: false; error: string }> {
  if (!Number.isInteger(input.amountPaisa) || input.amountPaisa <= 0) {
    return { ok: false, error: 'Amount must be greater than zero' };
  }

  const category = await db
    .prepare(`SELECT id FROM expense_categories WHERE id = ?`)
    .bind(input.categoryId)
    .first<{ id: string }>();
  if (!category) return { ok: false, error: 'Expense category not found' };

  const now = new Date().toISOString();
  const expenseId = newId('exp');

  await db.batch([
    db
      .prepare(
        `INSERT INTO expenses
           (id, doc_date, category_id, amount_paisa, cash_account_id, payee, notes,
            created_at, idempotency_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        expenseId,
        input.docDate,
        input.categoryId,
        input.amountPaisa,
        input.cashAccountId,
        input.payee ?? null,
        input.notes ?? null,
        now,
        normaliseIdempotencyKey(input.idempotencyKey),
      ),
    ...ledgerInsertStatements(
      db,
      buildLedgerRows({
        idFor: () => newId('le'),
        entryDate: input.docDate,
        docType: 'expense',
        docId: expenseId,
        lines: [
          {
            accountType: 'expense',
            accountId: input.categoryId,
            debitPaisa: input.amountPaisa,
            memo: input.payee ?? 'Expense',
          },
          {
            accountType: 'cash',
            accountId: input.cashAccountId,
            creditPaisa: input.amountPaisa,
            memo: 'Paid',
          },
        ],
        now,
      }),
    ),
    db
      .prepare(
        `INSERT INTO audit_log (id, at, user_id, action, entity_type, entity_id, detail_json)
         VALUES (?, ?, ?, 'create', 'expense', ?, ?)`,
      )
      .bind(newId('al'), now, input.userId ?? null, expenseId, JSON.stringify({ amount: input.amountPaisa })),
  ]);

  return { ok: true, expenseId };
}
