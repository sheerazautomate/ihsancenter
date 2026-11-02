/**
 * Double-entry helpers.
 *
 * Every financial document posts balanced lines. This is what makes
 * "revenue" and "totals of all companies" correct by construction rather than
 * by careful adding: gross profit is SUM(sales credits) - SUM(cogs debits) on the
 * same ledger that holds the cash, so the two can never disagree.
 *
 * Account types:
 *   Real accounts (carry a balance, need an account_id):
 *     customer, supplier, cash
 *   Nominal accounts (period movements, account_id is NULL):
 *     sales, sale_return, cogs, inventory, expense, discount, equity
 */

export type AccountType =
  | 'customer'
  | 'supplier'
  | 'cash'
  | 'sales'
  | 'sale_return'
  | 'cogs'
  | 'inventory'
  | 'expense'
  | 'discount'
  | 'equity';

export type DocType =
  | 'sale'
  | 'sale_return'
  | 'purchase'
  | 'purchase_return'
  | 'receipt'
  | 'payment'
  | 'expense'
  | 'adjustment'
  | 'opening'
  | 'void';

export interface LedgerLine {
  accountType: AccountType;
  accountId?: string | null;
  debitPaisa?: number;
  creditPaisa?: number;
  memo?: string | null;
}

export interface LedgerRow extends LedgerLine {
  id: string;
  entryDate: string;
  docType: DocType;
  docId: string;
  createdAt: string;
}

/**
 * Build rows for insertion. Enforces the two rules that keep the ledger sane:
 *   1. exactly one side of each entry is non-zero
 *   2. the document's entries sum to zero (balanced)
 */
export function buildLedgerRows(args: {
  idFor: () => string;
  entryDate: string;
  docType: DocType;
  docId: string;
  lines: LedgerLine[];
  now?: string;
}): LedgerRow[] {
  const now = args.now ?? new Date().toISOString();

  const rows: LedgerRow[] = args.lines.map((line) => {
    const debit = line.debitPaisa ?? 0;
    const credit = line.creditPaisa ?? 0;

    if (debit < 0 || credit < 0) {
      throw new Error(`Ledger entry cannot be negative (${line.accountType})`);
    }
    if ((debit === 0) === (credit === 0)) {
      throw new Error(
        `Ledger entry must have exactly one non-zero side (${line.accountType}: dr=${debit} cr=${credit})`,
      );
    }
    return {
      id: args.idFor(),
      entryDate: args.entryDate,
      accountType: line.accountType,
      accountId: line.accountId ?? null,
      debitPaisa: debit,
      creditPaisa: credit,
      docType: args.docType,
      docId: args.docId,
      memo: line.memo ?? null,
      createdAt: now,
    };
  });

  const totalDebit = rows.reduce((s, r) => s + (r.debitPaisa ?? 0), 0);
  const totalCredit = rows.reduce((s, r) => s + (r.creditPaisa ?? 0), 0);
  if (totalDebit !== totalCredit) {
    throw new Error(
      `Unbalanced ledger for ${args.docType} ${args.docId}: debit ${totalDebit} != credit ${totalCredit}`,
    );
  }

  return rows;
}

/** Flip debit/credit for a void reversal. */
export function reverseLines(lines: LedgerLine[]): LedgerLine[] {
  return lines.map((l) => ({
    accountType: l.accountType,
    accountId: l.accountId,
    debitPaisa: l.creditPaisa ?? 0,
    creditPaisa: l.debitPaisa ?? 0,
    memo: l.memo ? `Reversal: ${l.memo}` : 'Reversal',
  }));
}

/** D1 batch statements to insert ledger rows. */
export function ledgerInsertStatements(db: D1Database, rows: LedgerRow[]): D1PreparedStatement[] {
  return rows.map((r) =>
    db
      .prepare(
        `INSERT INTO ledger_entries
           (id, entry_date, account_type, account_id, debit_paisa, credit_paisa,
            doc_type, doc_id, memo, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        r.id,
        r.entryDate,
        r.accountType,
        r.accountId,
        r.debitPaisa ?? 0,
        r.creditPaisa ?? 0,
        r.docType,
        r.docId,
        r.memo ?? null,
        r.createdAt,
      ),
  );
}

// ============ reads ============

export interface AgingBuckets {
  /** Not yet due / 0-30 days */
  d0to30: number;
  d31to60: number;
  d61to90: number;
  d90plus: number;
}

export interface CreditPanel {
  customerId: string;
  name: string;
  creditLimitPaisa: number;
  outstandingPaisa: number;
  /** null when no limit is set (0 = unlimited) */
  availablePaisa: number | null;
  isCreditHold: boolean;
  hasLimit: boolean;
  /** true when a credit sale would cross the limit */
  wouldExceed: boolean;
  aging: AgingBuckets;
}

/**
 * Remaining balance of each open invoice: the credit portion it carried, minus
 * receipts allocated to it, minus credit notes from returns against it.
 *
 * Aging is per-invoice (not per-balance) so "31-60 days" means what an accountant
 * expects: money that has actually been outstanding that long.
 */
export const INVOICE_BALANCE_SQL = `
  SELECT i.id, i.customer_id, i.doc_date, i.invoice_no, i.total_paisa, i.credit_paisa,
         (i.credit_paisa
           - COALESCE((SELECT SUM(a.amount_paisa) FROM receipt_allocations a
                        WHERE a.invoice_id = i.id), 0)
           - COALESCE((SELECT SUM(r.credit_note_paisa) FROM sale_returns r
                        WHERE r.invoice_id = i.id AND r.status = 'open'), 0)
         ) AS bal
  FROM sales_invoices i
  WHERE i.status = 'open'
`;

export function agingSql(): string {
  return `
    SELECT
      COALESCE(SUM(CASE WHEN age <= 30 THEN bal END), 0)                  AS d0to30,
      COALESCE(SUM(CASE WHEN age BETWEEN 31 AND 60 THEN bal END), 0)      AS d31to60,
      COALESCE(SUM(CASE WHEN age BETWEEN 61 AND 90 THEN bal END), 0)      AS d61to90,
      COALESCE(SUM(CASE WHEN age > 90 THEN bal END), 0)                   AS d90plus
    FROM (
      SELECT CAST(julianday('now') - julianday(b.doc_date) AS INTEGER) AS age, b.bal
      FROM (${INVOICE_BALANCE_SQL}) b
      WHERE b.bal > 0 AND b.customer_id = ?
    )
  `;
}

export function creditPanelSql(): string {
  return `
    SELECT
      c.id                 AS customerId,
      c.name               AS name,
      c.credit_limit_paisa AS creditLimitPaisa,
      c.is_credit_hold     AS isCreditHold,
      COALESCE((
        SELECT SUM(l.debit_paisa - l.credit_paisa)
        FROM ledger_entries l
        WHERE l.account_type = 'customer' AND l.account_id = c.id
      ), 0)                AS outstandingPaisa,
      COALESCE((SELECT d0to30   FROM (${agingSql()})), 0) AS d0to30,
      COALESCE((SELECT d31to60  FROM (${agingSql()})), 0) AS d31to60,
      COALESCE((SELECT d61to90  FROM (${agingSql()})), 0) AS d61to90,
      COALESCE((SELECT d90plus  FROM (${agingSql()})), 0) AS d90plus
    FROM customers c
    WHERE c.id = ?
  `;
}

/** Params for creditPanelSql: the aging subqueries are correlated by customer id. */
export function creditPanelParams(customerId: string): unknown[] {
  return [customerId, customerId, customerId, customerId, customerId];
}

export function toCreditPanel(row: Record<string, unknown>, newCreditPaisa = 0): CreditPanel {
  const creditLimitPaisa = Number(row.creditLimitPaisa ?? 0);
  const outstandingPaisa = Number(row.outstandingPaisa ?? 0);
  const hasLimit = creditLimitPaisa > 0;
  const availablePaisa = hasLimit ? creditLimitPaisa - outstandingPaisa : null;

  return {
    customerId: String(row.customerId),
    name: String(row.name),
    creditLimitPaisa,
    outstandingPaisa,
    availablePaisa,
    hasLimit,
    isCreditHold: Number(row.isCreditHold ?? 0) === 1,
    wouldExceed: hasLimit && outstandingPaisa + newCreditPaisa > creditLimitPaisa,
    aging: {
      d0to30: Number(row.d0to30 ?? 0),
      d31to60: Number(row.d31to60 ?? 0),
      d61to90: Number(row.d61to90 ?? 0),
      d90plus: Number(row.d90plus ?? 0),
    },
  };
}
