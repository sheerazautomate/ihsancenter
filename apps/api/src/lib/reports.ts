/**
 * Reports.
 *
 * Every figure comes off one of two places: the double-entry ledger (money) or
 * stock movements (quantity). Nothing here re-derives a total from a cached
 * column, which is why a report and the ledger can never disagree.
 */

export interface CompanyTotalsRow {
  companyId: string;
  name: string;
  purchasesPaisa: number;
  salesPaisa: number;
  costPaisa: number;
  grossProfitPaisa: number;
  payablePaisa: number;
}

/** The "totals of all companies" report the shop asked for. */
export function companyTotalsSql(): string {
  return `
    SELECT
      c.id   AS companyId,
      c.name AS name,
      COALESCE(p.purchases, 0) AS purchasesPaisa,
      COALESCE(s.sales, 0)     AS salesPaisa,
      COALESCE(s.cost, 0)      AS costPaisa,
      COALESCE(s.sales, 0) - COALESCE(s.cost, 0) AS grossProfitPaisa,
      COALESCE(sl.balance, 0)  AS payablePaisa
    FROM companies c
    LEFT JOIN (
      SELECT company_id, SUM(total_paisa) AS purchases
      FROM purchases WHERE status = 'open' AND doc_date BETWEEN ? AND ?
      GROUP BY company_id
    ) p ON p.company_id = c.id
    LEFT JOIN (
      SELECT pr.company_id,
             SUM(l.line_total_paisa) AS sales,
             SUM(l.cost_paisa)       AS cost
      FROM sales_invoice_lines l
      JOIN sales_invoices i ON i.id = l.invoice_id AND i.status = 'open'
      JOIN products pr ON pr.id = l.product_id
      WHERE i.doc_date BETWEEN ? AND ?
      GROUP BY pr.company_id
    ) s ON s.company_id = c.id
    LEFT JOIN (
      SELECT account_id, SUM(credit_paisa - debit_paisa) AS balance
      FROM ledger_entries WHERE account_type = 'supplier'
      GROUP BY account_id
    ) sl ON sl.account_id = c.id
    WHERE c.is_active = 1
    ORDER BY c.name
  `;
}

/**
 * Profit and loss for a period.
 *
 * Revenue is net of returns, because a sale return debits the sales account.
 * COGS likewise nets off the reversal of cost when goods come back.
 */
export function profitAndLossSql(): string {
  return `
    SELECT
      COALESCE(SUM(CASE WHEN account_type = 'sales'
                        THEN credit_paisa - debit_paisa END), 0) AS revenuePaisa,
      COALESCE(SUM(CASE WHEN account_type = 'cogs'
                        THEN debit_paisa - credit_paisa END), 0) AS cogsPaisa,
      COALESCE(SUM(CASE WHEN account_type = 'expense'
                        THEN debit_paisa - credit_paisa END), 0) AS expensesPaisa,
      COALESCE(SUM(CASE WHEN account_type = 'discount'
                        THEN debit_paisa - credit_paisa END), 0) AS discountsPaisa
    FROM ledger_entries
    WHERE entry_date BETWEEN ? AND ?
  `;
}

/** Cash and bank position per account, as of now. */
export function cashPositionSql(): string {
  return `
    SELECT a.id, a.name, a.type,
           COALESCE((SELECT SUM(l.debit_paisa - l.credit_paisa)
                     FROM ledger_entries l
                     WHERE l.account_type = 'cash' AND l.account_id = a.id), 0) AS balancePaisa
    FROM cash_accounts a
    WHERE a.is_active = 1
    ORDER BY a.type DESC, a.name
  `;
}

/** Product-wise sales and margin for a period. */
export function productSalesSql(): string {
  return `
    SELECT
      p.id, p.name, co.name AS companyName, p.pack_size AS packSize,
      SUM(l.qty_milli)          AS qtyMilli,
      SUM(l.line_total_paisa)   AS revenuePaisa,
      SUM(l.cost_paisa)         AS costPaisa,
      SUM(l.line_total_paisa - l.cost_paisa) AS profitPaisa
    FROM sales_invoice_lines l
    JOIN sales_invoices i ON i.id = l.invoice_id AND i.status = 'open'
    JOIN products p ON p.id = l.product_id
    JOIN companies co ON co.id = p.company_id
    WHERE i.doc_date BETWEEN ? AND ?
    GROUP BY p.id
    ORDER BY revenuePaisa DESC
  `;
}

/** Expense totals by category for a period. */
export function expenseSummarySql(): string {
  return `
    SELECT ec.id, ec.name,
           COUNT(e.id)          AS count,
           COALESCE(SUM(e.amount_paisa), 0) AS totalPaisa
    FROM expense_categories ec
    LEFT JOIN expenses e ON e.category_id = ec.id AND e.status = 'open'
                        AND e.doc_date BETWEEN ? AND ?
    GROUP BY ec.id
    HAVING totalPaisa > 0 OR count > 0
    ORDER BY totalPaisa DESC
  `;
}

/**
 * Customer outstanding with aging, across all customers.
 *
 * The TOTAL comes from the ledger (SUM debit - credit), because that is the only
 * figure that can never disagree with the customer's own statement. Aging buckets
 * come from unpaid invoices, which is the only place an age can be attached.
 *
 * This two-source approach matters because they legitimately differ: a customer can
 * carry an opening balance, or an advance, with no invoice behind it. Reporting only
 * invoice balances made a customer who owed Rs 9,700 vanish from the report
 * entirely, which is exactly the kind of discrepancy that erodes trust in the books.
 * Anything not attributable to an invoice is surfaced as `unappliedPaisa` rather
 * than being silently dropped.
 */
export function receivableAgingSql(invoiceBalanceSql: string): string {
  return `
    SELECT
      c.id AS customerId, c.name, c.phone, c.village,
      c.credit_limit_paisa   AS creditLimitPaisa,
      c.is_credit_hold       AS isCreditHold,
      ledger.balancePaisa    AS totalPaisa,
      COALESCE(aging.d0to30, 0)  AS d0to30,
      COALESCE(aging.d31to60, 0) AS d31to60,
      COALESCE(aging.d61to90, 0) AS d61to90,
      COALESCE(aging.d90plus, 0) AS d90plus,
      ledger.balancePaisa
        - (COALESCE(aging.d0to30,0) + COALESCE(aging.d31to60,0)
           + COALESCE(aging.d61to90,0) + COALESCE(aging.d90plus,0)) AS unappliedPaisa
    FROM customers c
    JOIN (
      SELECT l.account_id,
             SUM(l.debit_paisa - l.credit_paisa) AS balancePaisa
      FROM ledger_entries l
      WHERE l.account_type = 'customer'
      GROUP BY l.account_id
    ) ledger ON ledger.account_id = c.id
    LEFT JOIN (
      SELECT b.customer_id,
             SUM(CASE WHEN b.age <= 30 THEN b.bal END)             AS d0to30,
             SUM(CASE WHEN b.age BETWEEN 31 AND 60 THEN b.bal END) AS d31to60,
             SUM(CASE WHEN b.age BETWEEN 61 AND 90 THEN b.bal END) AS d61to90,
             SUM(CASE WHEN b.age > 90 THEN b.bal END)              AS d90plus
      FROM (
        SELECT v.customer_id, v.bal,
               CAST(julianday(date('now', 'localtime')) - julianday(v.doc_date) AS INTEGER) AS age
        FROM (${invoiceBalanceSql}) v
        WHERE v.bal > 0
      ) b
      GROUP BY b.customer_id
    ) aging ON aging.customer_id = c.id
    WHERE ledger.balancePaisa <> 0
    ORDER BY COALESCE(aging.d90plus, 0) DESC, ledger.balancePaisa DESC
  `;
}

/**
 * What the shop owes each company.
 *
 * This MUST come from the supplier ledger, not from purchases minus payments.
 * The arithmetic version silently ignored every payment made against an opening
 * balance (or any payment not tied to a purchase), so paying a company Rs 50,000
 * left the payable unchanged on this screen while the ledger and the dashboard
 * both showed the correct reduced figure. Two screens disagreeing about the same
 * number is worse than either being wrong.
 */
export function payableAgingSql(): string {
  // Wrapped in a subquery because SQLite rejects HAVING without GROUP BY, and
  // grouping just to filter out zero balances would be noise.
  return `
    SELECT companyId, name, totalPaisa FROM (
      SELECT
        c.id AS companyId,
        c.name,
        COALESCE((
          SELECT SUM(l.credit_paisa - l.debit_paisa)
          FROM ledger_entries l
          WHERE l.account_type = 'supplier' AND l.account_id = c.id
        ), 0) AS totalPaisa
      FROM companies c
      WHERE c.is_active = 1
    )
    WHERE totalPaisa <> 0
    ORDER BY totalPaisa DESC
  `;
}

/**
 * Daily summary for the dashboard: sales, cash collected, credit given, expenses.
 * Kept as one query so the four numbers are always from the same moment.
 */
export function dailySummarySql(): string {
  return `
    SELECT
      COALESCE((SELECT SUM(total_paisa) FROM sales_invoices
                WHERE status = 'open' AND doc_date = ?), 0)                     AS salesPaisa,
      COALESCE((SELECT SUM(paid_cash_paisa + paid_bank_paisa) FROM sales_invoices
                WHERE status = 'open' AND doc_date = ?), 0)                     AS collectedPaisa,
      COALESCE((SELECT SUM(credit_paisa) FROM sales_invoices
                WHERE status = 'open' AND doc_date = ?), 0)                     AS creditGivenPaisa,
      COALESCE((SELECT SUM(amount_paisa) FROM expenses
                WHERE status = 'open' AND doc_date = ?), 0)                     AS expensesPaisa,
      COALESCE((SELECT SUM(amount_paisa) FROM customer_receipts
                WHERE status = 'open' AND doc_date = ?), 0)                     AS receiptsPaisa,
      COALESCE((SELECT COUNT(*) FROM sales_invoices
                WHERE status = 'open' AND doc_date = ?), 0)                     AS invoiceCount
  `;
}
