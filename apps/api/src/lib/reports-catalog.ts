import { INVOICE_BALANCE_SQL } from './ledger';

/**
 * Report catalogue.
 *
 * Every export is one entry here: a title, columns, and a SQL query that returns
 * rows in that column order. One place to look, one place to add, and the web UI
 * is driven off the same list so a new report needs no front-end change.
 *
 * Two rules the queries follow throughout:
 *
 * 1. **Rupees in, not paisa.** `$paisa` on a select column divides by 100. The
 *    shop reads a spreadsheet, not a ledger dump.
 * 2. **Nothing is hidden.** Voided documents are included with their status and
 *    reason, because "the record shows it was voided" is the only defence a shop
 *    has when a farmer disputes a bill. Hiding them would make the export lie by
 *    omission -- while the app itself already treats void docs as absent from the
 *    totals.
 */

export interface ReportDef {
  /** URL slug: /api/reports/export/<slug> */
  slug: string;
  title: string;
  /** Paragraph shown above the button in the UI, and in the file's first sheet. */
  description: string;
  columns: string[];
  sql: string;
  widths?: number[];
  moneyColumns?: number[];
  /** Column index holding YYYY-MM-DD for the date filter. 0 = whole report. */
  dateColumn?: 0 | 1 | 2 | 3;
  group: 'Customers' | 'Companies' | 'Stock' | 'Cash' | 'Expenses' | 'System';
  /** True when the report covers one specific customer/company/supplier. */
  scope?: 'customer' | 'company';
}

/** Rupee conversion, used in every money column. */
const R = (expr: string) => `ROUND(${expr} / 100.0, 2)`;

/** Quantity in units, from milli-units. */
const Q = (expr: string) => `ROUND(${expr} / 1000.0, 3)`;

export const REPORTS: ReportDef[] = [
  // ---------------------------------------------------------------- customers
  {
    slug: 'customers',
    title: 'Customer list',
    description: 'Every customer with what they owe today, their limit and their status.',
    group: 'Customers',
    columns: ['Name', 'Phone', 'Village', 'Type', 'Credit limit (Rs)', 'Owes now (Rs)', 'On credit hold', 'Active', 'Added'],
    sql: `
      SELECT c.name, c.phone, c.village, c.type,
             ${R('c.credit_limit_paisa')} AS credit_limit,
             ${R(`COALESCE((SELECT SUM(l.debit_paisa - l.credit_paisa) FROM ledger_entries l
                             WHERE l.account_type = 'customer' AND l.account_id = c.id), 0)`)} AS owes,
             CASE c.is_credit_hold WHEN 1 THEN 'yes' ELSE 'no' END AS hold,
             CASE c.is_active WHEN 1 THEN 'yes' ELSE 'no' END AS active,
             substr(c.created_at, 1, 10) AS added
      FROM customers c
      ORDER BY c.name`,
    widths: [180, 110, 120, 70, 90, 90, 70, 60, 80],
    moneyColumns: [4, 5],
  },
  {
    slug: 'customer-history',
    title: 'Customer history — every movement',
    description:
      'One customer in full: every invoice, receipt, return and opening balance, oldest first, with a running balance. This is the page to show a farmer who questions his account.',
    group: 'Customers',
    scope: 'customer',
    columns: ['Date', 'Document', 'Type', 'Detail', 'Debit (Rs)', 'Credit (Rs)', 'Balance (Rs)'],
    sql: `
      SELECT * FROM (
        SELECT e.entry_date AS d, e.doc_type, e.doc_id, COALESCE(e.memo, '') AS detail,
               ${R('e.debit_paisa')} AS debit, ${R('e.credit_paisa')} AS credit,
               ${R('SUM(e.debit_paisa - e.credit_paisa) OVER (ORDER BY e.entry_date, e.id)')} AS running
        FROM ledger_entries e
        WHERE e.account_type = 'customer' AND e.account_id = ?
        ORDER BY e.entry_date, e.id
      )`,
    widths: [85, 70, 110, 300, 90, 90, 95],
    moneyColumns: [4, 5, 6],
  },
  {
    slug: 'customer-invoices',
    title: 'Customer invoices',
    description: 'Every invoice for one customer, with what was paid at the counter and what is still owed on it.',
    group: 'Customers',
    scope: 'customer',
    columns: ['Date', 'Invoice', 'Total (Rs)', 'Paid cash (Rs)', 'Paid bank (Rs)', 'Credit (Rs)', 'Received since (Rs)', 'Still owed (Rs)', 'Status'],
    sql: `
      SELECT i.doc_date, i.invoice_no,
             ${R('i.total_paisa')}, ${R('i.paid_cash_paisa')}, ${R('i.paid_bank_paisa')},
             ${R('i.credit_paisa')},
             ${R(`COALESCE((SELECT SUM(a.amount_paisa) FROM receipt_allocations a WHERE a.invoice_id = i.id), 0)
                 + COALESCE((SELECT SUM(r.credit_note_paisa) FROM sale_returns r
                              WHERE r.invoice_id = i.id AND r.status = 'open'), 0)`)} AS settled,
             ${R(`MAX(0, i.credit_paisa
                 - COALESCE((SELECT SUM(a.amount_paisa) FROM receipt_allocations a WHERE a.invoice_id = i.id), 0)
                 - COALESCE((SELECT SUM(r.credit_note_paisa) FROM sale_returns r
                              WHERE r.invoice_id = i.id AND r.status = 'open'), 0))`)} AS still_owed,
             i.status
      FROM sales_invoices i
      WHERE i.customer_id = ?
      ORDER BY i.doc_date, i.invoice_no`,
    widths: [85, 120, 85, 85, 85, 85, 100, 95, 65],
    moneyColumns: [2, 3, 4, 5, 6, 7],
  },
  {
    slug: 'customer-items',
    title: 'Customer items bought',
    description: 'Line by line: what this customer actually took, quantity and price. Answers "what did I spray last season".',
    group: 'Customers',
    scope: 'customer',
    columns: ['Date', 'Invoice', 'Product', 'Qty', 'Unit', 'Rate (Rs)', 'Line total (Rs)'],
    sql: `
      SELECT i.doc_date, i.invoice_no, p.name, ${Q('l.qty_milli')} AS qty, p.unit,
             ${R('l.rate_paisa')}, ${R('l.line_total_paisa')}
      FROM sales_invoice_lines l
      JOIN sales_invoices i ON i.id = l.invoice_id
      JOIN products p ON p.id = l.product_id
      WHERE i.customer_id = ?
      ORDER BY i.doc_date, i.invoice_no, l.sort_order`,
    widths: [85, 120, 240, 70, 60, 85, 95],
    moneyColumns: [3, 5, 6],
  },
  {
    slug: 'customer-receipts',
    title: 'Customer receipts',
    description: 'Money actually collected from one customer, and which invoice each receipt was applied to.',
    group: 'Customers',
    scope: 'customer',
    columns: ['Date', 'Receipt', 'Amount (Rs)', 'Mode', 'Account', 'Reference', 'Applied to', 'Status'],
    sql: `
      SELECT r.doc_date, r.receipt_no, ${R('r.amount_paisa')}, r.mode, ca.name,
             COALESCE(r.reference, ''),
             COALESCE((SELECT GROUP_CONCAT(i.invoice_no || ' (' || printf('%.2f', a.amount_paisa / 100.0) || ')', ', ')
                       FROM receipt_allocations a
                       JOIN sales_invoices i ON i.id = a.invoice_id
                       WHERE a.receipt_id = r.id), 'unallocated / advance'),
             r.status
      FROM customer_receipts r
      JOIN cash_accounts ca ON ca.id = r.cash_account_id
      WHERE r.customer_id = ?
      ORDER BY r.doc_date, r.receipt_no`,
    widths: [85, 120, 85, 60, 110, 110, 260, 65],
    moneyColumns: [2],
  },
  {
    slug: 'sale-returns',
    title: 'Sale returns',
    description: 'Goods a customer brought back: what, why, and whether it went to cash or against their balance.',
    group: 'Customers',
    columns: ['Date', 'Return', 'Customer', 'Against invoice', 'Total (Rs)', 'Cash refund (Rs)', 'Bank refund (Rs)', 'Credit note (Rs)', 'Reason', 'Status'],
    sql: `
      SELECT r.doc_date, r.return_no, c.name,
             COALESCE((SELECT i.invoice_no FROM sales_invoices i WHERE i.id = r.invoice_id), '—'),
             ${R('r.total_paisa')}, ${R('r.refund_cash_paisa')}, ${R('r.refund_bank_paisa')},
             ${R('r.credit_note_paisa')}, COALESCE(r.reason, ''), r.status
      FROM sale_returns r
      JOIN customers c ON c.id = r.customer_id
      ORDER BY r.doc_date DESC, r.return_no DESC`,
    widths: [85, 120, 160, 120, 85, 90, 90, 90, 220, 60],
    moneyColumns: [4, 5, 6, 7],
  },

  // ---------------------------------------------------------------- companies
  {
    slug: 'companies',
    title: 'Company list',
    description: 'Every supplier with what the shop still owes them and their current status.',
    group: 'Companies',
    columns: ['Name', 'Contact person', 'Phone', 'Address', 'Payable now (Rs)', 'Products', 'Active'],
    sql: `
      SELECT c.name, COALESCE(c.contact_person, ''), COALESCE(c.phone, ''), COALESCE(c.address, ''),
             ${R(`COALESCE((SELECT SUM(l.credit_paisa - l.debit_paisa) FROM ledger_entries l
                             WHERE l.account_type = 'supplier' AND l.account_id = c.id), 0)`)} AS payable,
             (SELECT COUNT(*) FROM products p WHERE p.company_id = c.id) AS products,
             CASE c.is_active WHEN 1 THEN 'yes' ELSE 'no' END
      FROM companies c
      ORDER BY c.name`,
    widths: [160, 130, 110, 200, 100, 70, 60],
    moneyColumns: [4],
  },
  {
    slug: 'company-history',
    title: 'Company history — every movement',
    description: 'One supplier in full: every purchase, payment and return, with the running payable.',
    group: 'Companies',
    scope: 'company',
    columns: ['Date', 'Type', 'Detail', 'Debit (Rs)', 'Credit (Rs)', 'Payable (Rs)'],
    sql: `
      SELECT e.entry_date, e.doc_type, COALESCE(e.memo, ''),
             ${R('e.debit_paisa')}, ${R('e.credit_paisa')},
             ${R('SUM(e.credit_paisa - e.debit_paisa) OVER (ORDER BY e.entry_date, e.id)')}
      FROM ledger_entries e
      WHERE e.account_type = 'supplier' AND e.account_id = ?
      ORDER BY e.entry_date, e.id`,
    widths: [85, 110, 300, 90, 90, 95],
    moneyColumns: [3, 4, 5],
  },
  {
    slug: 'company-purchases',
    title: 'Company purchases',
    description: 'Every bill taken from one supplier, with what was paid at the time and what stayed payable.',
    group: 'Companies',
    scope: 'company',
    columns: ['Date', 'Purchase', 'Supplier bill no.', 'Subtotal (Rs)', 'Discount (Rs)', 'Freight (Rs)', 'Total (Rs)', 'Paid cash (Rs)', 'Paid bank (Rs)', 'Payable (Rs)', 'Status'],
    sql: `
      SELECT p.doc_date, p.purchase_no, COALESCE(p.supplier_invoice_no, ''),
             ${R('p.subtotal_paisa')}, ${R('p.discount_paisa')}, ${R('p.freight_paisa')},
             ${R('p.total_paisa')}, ${R('p.paid_cash_paisa')}, ${R('p.paid_bank_paisa')},
             ${R('p.payable_paisa')}, p.status
      FROM purchases p
      WHERE p.company_id = ?
      ORDER BY p.doc_date, p.purchase_no`,
    widths: [85, 125, 130, 90, 85, 80, 90, 90, 90, 90, 60],
    moneyColumns: [3, 4, 5, 6, 7, 8, 9],
  },
  {
    slug: 'company-payments',
    title: 'Payments to companies',
    description: 'Money paid out to one supplier, by cash, bank or cheque.',
    group: 'Companies',
    scope: 'company',
    columns: ['Date', 'Payment', 'Amount (Rs)', 'Mode', 'Account', 'Reference', 'Status'],
    sql: `
      SELECT s.doc_date, s.payment_no, ${R('s.amount_paisa')}, s.mode, ca.name,
             COALESCE(s.reference, ''), s.status
      FROM supplier_payments s
      JOIN cash_accounts ca ON ca.id = s.cash_account_id
      WHERE s.company_id = ?
      ORDER BY s.doc_date, s.payment_no`,
    widths: [85, 125, 95, 60, 110, 110, 60],
    moneyColumns: [2],
  },
  {
    slug: 'purchase-returns',
    title: 'Purchase returns',
    description: 'Goods sent back to suppliers, and whether the money came back or the payable was reduced.',
    group: 'Companies',
    columns: ['Date', 'Return', 'Company', 'Total (Rs)', 'Cash back (Rs)', 'Bank back (Rs)', 'Payable reduced (Rs)', 'Reason', 'Status'],
    sql: `
      SELECT r.doc_date, r.return_no, c.name, ${R('r.total_paisa')},
             ${R('r.refund_cash_paisa')}, ${R('r.refund_bank_paisa')}, ${R('r.payable_reduction_paisa')},
             COALESCE(r.reason, ''), r.status
      FROM purchase_returns r
      JOIN companies c ON c.id = r.company_id
      ORDER BY r.doc_date DESC, r.return_no DESC`,
    widths: [85, 125, 160, 90, 90, 90, 110, 220, 60],
    moneyColumns: [3, 4, 5, 6],
  },

  // -------------------------------------------------------------------- stock
  {
    slug: 'stock-in',
    title: 'Stock coming in',
    description: 'Every unit that entered the shop: opening stock, purchases, and customer returns. With the cost it came in at.',
    group: 'Stock',
    columns: ['Date', 'Product', 'Unit', 'Type', 'Qty in', 'Unit cost (Rs)', 'Value (Rs)', 'Document', 'Balance after'],
    sql: `
      SELECT m.movement_date, p.name, p.unit, m.type,
             ${Q('ABS(m.qty_change_milli)')} AS qty,
             ${R('m.unit_cost_paisa')},
             ${R('ABS(m.qty_change_milli) * m.unit_cost_paisa / 1000')} AS value,
             m.doc_type || ' ' || m.doc_id,
             ${Q('m.balance_after_milli')}
      FROM stock_movements m
      JOIN products p ON p.id = m.product_id
      WHERE m.qty_change_milli > 0
      ORDER BY m.movement_date DESC, m.created_at DESC`,
    widths: [85, 240, 60, 110, 70, 95, 95, 220, 85],
    moneyColumns: [4, 5, 6],
  },
  {
    slug: 'stock-out',
    title: 'Stock going out',
    description: 'Every unit that left the shop: sales, and goods returned to suppliers. With the cost it left at.',
    group: 'Stock',
    columns: ['Date', 'Product', 'Unit', 'Type', 'Qty out', 'Unit cost (Rs)', 'Value (Rs)', 'Document', 'Balance after'],
    sql: `
      SELECT m.movement_date, p.name, p.unit, m.type,
             ${Q('ABS(m.qty_change_milli)')} AS qty,
             ${R('m.unit_cost_paisa')},
             ${R('ABS(m.qty_change_milli) * m.unit_cost_paisa / 1000')} AS value,
             m.doc_type || ' ' || m.doc_id,
             ${Q('m.balance_after_milli')}
      FROM stock_movements m
      JOIN products p ON p.id = m.product_id
      WHERE m.qty_change_milli < 0
      ORDER BY m.movement_date DESC, m.created_at DESC`,
    widths: [85, 240, 60, 110, 70, 95, 95, 220, 85],
    moneyColumns: [4, 5, 6],
  },
  {
    slug: 'stock-movements',
    title: 'All stock movements',
    description: 'Both directions in one sheet, with a signed quantity. The full audit trail of the shelf.',
    group: 'Stock',
    columns: ['Date', 'Product', 'Unit', 'Type', 'Qty change', 'Unit cost (Rs)', 'Document', 'Balance after', 'Note'],
    sql: `
      SELECT m.movement_date, p.name, p.unit, m.type,
             ${Q('m.qty_change_milli')} AS qty_change,
             ${R('m.unit_cost_paisa')},
             m.doc_type || ' ' || m.doc_id,
             ${Q('m.balance_after_milli')},
             COALESCE(m.note, '')
      FROM stock_movements m
      JOIN products p ON p.id = m.product_id
      ORDER BY m.movement_date DESC, m.created_at DESC`,
    widths: [85, 240, 60, 110, 85, 95, 220, 85, 200],
    moneyColumns: [5],
  },
  {
    slug: 'stock-current',
    title: 'Stock on hand',
    description: 'What is on the shelf right now, what it cost, and what it is worth at selling price.',
    group: 'Stock',
    columns: ['Product', 'Company', 'Category', 'Unit', 'Pack', 'On hand', 'Reorder level', 'Avg cost (Rs)', 'Stock value (Rs)', 'Sale rate (Rs)', 'Sale value (Rs)', 'Status'],
    sql: `
      SELECT p.name, c.name, p.category, p.unit, COALESCE(p.pack_size, ''),
             ${Q('p.qty_on_hand_milli')}, ${Q('p.reorder_level_milli')},
             ${R('p.avg_cost_paisa')},
             ${R('p.qty_on_hand_milli * p.avg_cost_paisa / 1000')},
             ${R('p.sale_rate_paisa')},
             ${R('p.qty_on_hand_milli * p.sale_rate_paisa / 1000')},
             CASE WHEN p.qty_on_hand_milli <= 0 THEN 'out of stock'
                  WHEN p.qty_on_hand_milli <= p.reorder_level_milli THEN 'reorder'
                  ELSE 'ok' END
      FROM products p JOIN companies c ON c.id = p.company_id
      WHERE p.is_active = 1
      ORDER BY p.name`,
    widths: [240, 140, 90, 60, 80, 80, 95, 95, 110, 95, 110, 90],
    moneyColumns: [7, 8, 9, 10],
  },

  // --------------------------------------------------------------------- cash
  {
    slug: 'cash-flow',
    title: 'Cash flow — every rupee in and out',
    description:
      'Every cash and bank movement in one sheet: sales collected, receipts, supplier payments, expenses, opening balances. This is the till.',
    group: 'Cash',
    columns: ['Date', 'Account', 'In (Rs)', 'Out (Rs)', 'Running balance (Rs)', 'Document type', 'Memo'],
    sql: `
      SELECT e.entry_date, COALESCE(ca.name, e.account_id),
             ${R('e.debit_paisa')}, ${R('e.credit_paisa')},
             ${R('SUM(e.debit_paisa - e.credit_paisa) OVER (PARTITION BY e.account_id ORDER BY e.entry_date, e.id)')},
             e.doc_type, COALESCE(e.memo, '')
      FROM ledger_entries e
      LEFT JOIN cash_accounts ca ON ca.id = e.account_id
      WHERE e.account_type = 'cash'
      ORDER BY e.account_id, e.entry_date, e.id`,
    widths: [85, 130, 95, 95, 120, 110, 300],
    moneyColumns: [2, 3, 4],
  },
  {
    slug: 'accounts',
    title: 'Cash and bank accounts',
    description: 'What is in each account right now, derived from the ledger.',
    group: 'Cash',
    columns: ['Account', 'Type', 'Bank', 'Account no.', 'Balance now (Rs)'],
    sql: `
      SELECT ca.name, ca.type, COALESCE(ca.bank_name, ''), COALESCE(ca.account_no, ''),
             ${R(`COALESCE((SELECT SUM(l.debit_paisa - l.credit_paisa) FROM ledger_entries l
                             WHERE l.account_type = 'cash' AND l.account_id = ca.id), 0)`)}
      FROM cash_accounts ca
      WHERE ca.is_active = 1
      ORDER BY ca.type DESC, ca.name`,
    widths: [150, 70, 140, 140, 110],
    moneyColumns: [4],
  },

  // ----------------------------------------------------------------- expenses
  {
    slug: 'expenses',
    title: 'Expenses',
    description: 'Every expense paid out, with its category, payee and which account it came from.',
    group: 'Expenses',
    columns: ['Date', 'Category', 'Payee', 'Amount (Rs)', 'Account', 'Notes', 'Status'],
    sql: `
      SELECT e.doc_date, ec.name, COALESCE(e.payee, ''), ${R('e.amount_paisa')},
             ca.name, COALESCE(e.notes, ''), e.status
      FROM expenses e
      JOIN expense_categories ec ON ec.id = e.category_id
      JOIN cash_accounts ca ON ca.id = e.cash_account_id
      ORDER BY e.doc_date DESC, e.id DESC`,
    widths: [85, 150, 160, 95, 120, 260, 60],
    moneyColumns: [3],
  },

  // ------------------------------------------------------------------- system
  {
    slug: 'all-sales',
    title: 'All sales invoices',
    description: 'Every invoice ever issued, all customers, with payment state.',
    group: 'System',
    columns: ['Date', 'Invoice', 'Customer', 'Total (Rs)', 'Paid cash (Rs)', 'Paid bank (Rs)', 'Credit (Rs)', 'Received since (Rs)', 'Still owed (Rs)', 'Status'],
    sql: `
      SELECT i.doc_date, i.invoice_no, c.name, ${R('i.total_paisa')},
             ${R('i.paid_cash_paisa')}, ${R('i.paid_bank_paisa')}, ${R('i.credit_paisa')},
             ${R(`COALESCE((SELECT SUM(a.amount_paisa) FROM receipt_allocations a WHERE a.invoice_id = i.id), 0)
                 + COALESCE((SELECT SUM(r.credit_note_paisa) FROM sale_returns r
                              WHERE r.invoice_id = i.id AND r.status = 'open'), 0)`)} AS settled,
             ${R(`MAX(0, i.credit_paisa
                 - COALESCE((SELECT SUM(a.amount_paisa) FROM receipt_allocations a WHERE a.invoice_id = i.id), 0)
                 - COALESCE((SELECT SUM(r.credit_note_paisa) FROM sale_returns r
                              WHERE r.invoice_id = i.id AND r.status = 'open'), 0))`)} AS still_owed,
             i.status
      FROM sales_invoices i
      JOIN customers c ON c.id = i.customer_id
      ORDER BY i.doc_date DESC, i.invoice_no DESC`,
    widths: [85, 120, 160, 90, 90, 90, 90, 100, 95, 60],
    moneyColumns: [3, 4, 5, 6, 7, 8],
  },
  {
    slug: 'all-purchases',
    title: 'All purchases',
    description: 'Every bill from every supplier.',
    group: 'System',
    columns: ['Date', 'Purchase', 'Company', 'Supplier bill no.', 'Total (Rs)', 'Paid cash (Rs)', 'Paid bank (Rs)', 'Payable (Rs)', 'Status'],
    sql: `
      SELECT p.doc_date, p.purchase_no, c.name, COALESCE(p.supplier_invoice_no, ''),
             ${R('p.total_paisa')}, ${R('p.paid_cash_paisa')}, ${R('p.paid_bank_paisa')},
             ${R('p.payable_paisa')}, p.status
      FROM purchases p JOIN companies c ON c.id = p.company_id
      ORDER BY p.doc_date DESC, p.purchase_no DESC`,
    widths: [85, 125, 160, 130, 90, 90, 90, 90, 60],
    moneyColumns: [4, 5, 6, 7],
  },
  {
    slug: 'all-payments',
    title: 'All payments to companies',
    description: 'Every payment made to every supplier.',
    group: 'System',
    columns: ['Date', 'Payment', 'Company', 'Amount (Rs)', 'Mode', 'Account', 'Reference', 'Status'],
    sql: `
      SELECT s.doc_date, s.payment_no, c.name, ${R('s.amount_paisa')}, s.mode, ca.name,
             COALESCE(s.reference, ''), s.status
      FROM supplier_payments s
      JOIN companies c ON c.id = s.company_id
      JOIN cash_accounts ca ON ca.id = s.cash_account_id
      ORDER BY s.doc_date DESC, s.payment_no DESC`,
    widths: [85, 125, 160, 95, 60, 120, 110, 60],
    moneyColumns: [3],
  },
  {
    slug: 'ledger',
    title: 'Full ledger',
    description: 'Every double entry in the system. For a professional rebuilding the books or checking a balance.',
    group: 'System',
    columns: ['Date', 'Account type', 'Account', 'Debit (Rs)', 'Credit (Rs)', 'Document type', 'Document', 'Memo'],
    sql: `
      SELECT e.entry_date, e.account_type, COALESCE(e.account_id, ''),
             ${R('e.debit_paisa')}, ${R('e.credit_paisa')}, e.doc_type, e.doc_id,
             COALESCE(e.memo, '')
      FROM ledger_entries e
      ORDER BY e.entry_date DESC, e.id DESC`,
    widths: [85, 100, 180, 90, 90, 110, 200, 280],
    moneyColumns: [3, 4],
  },
  {
    slug: 'audit',
    title: 'Activity log',
    description: 'Who did what, and when — logins, documents created, voided records, edits.',
    group: 'System',
    columns: ['When', 'User', 'Action', 'Entity', 'Entity id', 'Detail'],
    sql: `
      SELECT e.at, COALESCE(u.username, 'system'), e.action,
             COALESCE(e.entity_type, ''), COALESCE(e.entity_id, ''), COALESCE(e.detail_json, '')
      FROM audit_log e
      LEFT JOIN users u ON u.id = e.user_id
      ORDER BY e.at DESC`,
    widths: [150, 120, 100, 110, 200, 320],
  },
];

export function findReport(slug: string): ReportDef | undefined {
  return REPORTS.find((r) => r.slug === slug);
}

/** The invoice-balance expression is reused by the receivable report below. */
export const RECEIVABLE_SQL = INVOICE_BALANCE_SQL;
