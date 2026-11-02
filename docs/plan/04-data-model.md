# Ihsan Center — Phase 3: Data Model (DRAFT v0.1)

**Stack (approved):** React SPA on Cloudflare Pages · Hono API on Workers · **D1 (SQLite)** · R2 + GitHub for backups.
**Status:** for review — no code written yet.

---

## 1. Ground rules

| Rule | Why |
|---|---|
| **All money = `INTEGER` paisa** (`123450` = Rs 1,234.50) | SQLite has no decimal type. Floats produce one-paisa gaps in customer balances that are unexplainable a year later |
| **All quantities = `INTEGER` milli-units** (`2500` = 2.5 kg) | Same reason. Handles loose fertilizer sold by weight and whole bottles alike |
| **IDs = ULID strings, generated in code before the write** | D1's `batch()` cannot read a result and use it in a later statement. Every parent id must already exist when the statement list is built |
| **Document numbers = allocated separately, then used** | `UPDATE doc_sequences … RETURNING` in one atomic step *before* the batch. A failed batch burns one number — see §10 |
| **Dates:** `doc_date TEXT 'YYYY-MM-DD'` (Asia/Karachi business day), `created_at TEXT` ISO-8601 UTC | "Today" must mean the shop's today, not UTC's |
| **Nothing is deleted.** `status` = `open` / `void`, with reason + timestamp | Free tier gives no PITR; the app must be its own audit trail |
| **Ledger is double-entry.** Every document's ledger lines sum to zero | Makes revenue, gross profit and "totals of all companies" correct by construction rather than by careful adding |

---

## 2. Why double-entry, when you asked for a simple shop system

It sounds academic. It isn't — it's the cheapest way to guarantee your two headline questions are always right:

- *"How much revenue is being generated?"*
- *"What are the totals of all 4 companies?"*

With double entry, gross profit isn't a report you compute from invoices and hope matches; it is `SUM(sales credits) − SUM(cogs debits)` on the same ledger that holds the cash. If a number is wrong, the ledger itself won't balance and a self-check catches it that night.

A sale of Rs 10,000 (cost Rs 7,000), Rs 4,000 cash + Rs 6,000 udhaar:

```
Dr  Cash (counter)           4,000
Dr  Receivable — Ali Khan    6,000
    Cr  Sales                      10,000
Dr  COGS                     7,000
    Cr  Inventory                  7,000
```

Every document, including expenses, purchases and receipts, produces lines like this. The manager never sees them — they see the bill.

---

## 3. Entity map

```
companies ──< products ──< stock_movements
    │                          
    ├──< purchases ──< purchase_lines
    ├──< purchase_returns ──< purchase_return_lines
    └──< supplier_payments

customers ──< sales_invoices ──< sales_invoice_lines
    │              └──< sale_returns
    ├──< customer_receipts ──< receipt_allocations
    └──< ledger_entries  (account_type='customer')

cash_accounts ──< ledger_entries (account_type='cash'|'bank')
expense_categories ──< expenses ──< ledger_entries
            
ledger_entries  ← every financial document posts here
stock_movements ← every stock-changing document posts here
audit_log, doc_sequences, tx_guard, daily_closings, settings, users
```

---

## 4. Schema (DDL, SQLite / D1 dialect)

```sql
-- ============ identity & configuration ============
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,          -- PBKDF2-SHA256, hex
  iterations    INTEGER NOT NULL,       -- stored per-user so we can raise it later
  token_version INTEGER NOT NULL DEFAULT 1,  -- bump to invalidate all sessions
  role          TEXT NOT NULL DEFAULT 'manager' CHECK (role IN ('manager','clerk','accountant')),
  is_active     INTEGER NOT NULL DEFAULT 1,
  last_login_at TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE settings (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),   -- single row
  shop_name           TEXT NOT NULL DEFAULT 'Ihsan Center',
  address             TEXT, phone TEXT, logo_url TEXT,
  receipt_footer      TEXT,
  invoice_prefix      TEXT NOT NULL DEFAULT 'INV',
  allow_negative_stock INTEGER NOT NULL DEFAULT 0,
  low_stock_default_milli INTEGER NOT NULL DEFAULT 0,
  updated_at          TEXT NOT NULL
);

-- ============ master data ============
CREATE TABLE companies (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,      -- Tahafuz, SunCrop, Engro, Syngenta
  contact_person TEXT, phone TEXT, address TEXT, notes TEXT,
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL
);

CREATE TABLE products (
  id                 TEXT PRIMARY KEY,
  company_id         TEXT NOT NULL REFERENCES companies(id),
  name               TEXT NOT NULL,
  sku                TEXT,
  barcode            TEXT,
  category           TEXT NOT NULL CHECK (category IN
                       ('insecticide','fungicide','herbicide','fertilizer','seed','other')),
  unit               TEXT NOT NULL DEFAULT 'pcs',   -- pcs / ml / kg / L
  pack_size          TEXT,                          -- "250 ml", "1 kg" (display only)
  purchase_rate_paisa INTEGER NOT NULL DEFAULT 0,
  sale_rate_paisa     INTEGER NOT NULL DEFAULT 0,
  reorder_level_milli INTEGER NOT NULL DEFAULT 0,
  qty_on_hand_milli   INTEGER NOT NULL DEFAULT 0,   -- maintained ONLY by stock batches
  is_active          INTEGER NOT NULL DEFAULT 1,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  UNIQUE (company_id, name)                          -- stops the "SunCrop Kan Ram" duplicate
);
CREATE INDEX idx_products_company ON products(company_id, is_active);
CREATE INDEX idx_products_name    ON products(name);
CREATE INDEX idx_products_sku     ON products(sku);
CREATE INDEX idx_products_barcode ON products(barcode);

CREATE TABLE customers (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  phone             TEXT,
  village           TEXT,
  address           TEXT,
  type              TEXT NOT NULL DEFAULT 'farmer'
                      CHECK (type IN ('farmer','dealer','walkin')),
  credit_limit_paisa INTEGER NOT NULL DEFAULT 0,
  is_credit_hold    INTEGER NOT NULL DEFAULT 0,
  notes             TEXT,
  is_active         INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_customers_phone ON customers(phone) WHERE phone IS NOT NULL;
CREATE INDEX idx_customers_name ON customers(name);

-- ============ sales ============
CREATE TABLE sales_invoices (
  id               TEXT PRIMARY KEY,
  invoice_no       TEXT NOT NULL UNIQUE,          -- INV-2026-00042
  doc_date         TEXT NOT NULL,
  customer_id      TEXT NOT NULL REFERENCES customers(id),
  subtotal_paisa   INTEGER NOT NULL,
  discount_paisa   INTEGER NOT NULL DEFAULT 0,
  total_paisa      INTEGER NOT NULL,
  paid_cash_paisa  INTEGER NOT NULL DEFAULT 0,
  paid_bank_paisa  INTEGER NOT NULL DEFAULT 0,
  credit_paisa     INTEGER NOT NULL DEFAULT 0,
  cost_total_paisa INTEGER NOT NULL,              -- COGS snapshot at sale time
  cash_account_id  TEXT REFERENCES cash_accounts(id),
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','void')),
  void_reason      TEXT, voided_at TEXT,
  notes            TEXT,
  created_at       TEXT NOT NULL,
  -- the invariant that makes a bill a bill:
  CHECK (total_paisa = paid_cash_paisa + paid_bank_paisa + credit_paisa),
  CHECK (total_paisa >= 0),
  CHECK (credit_paisa = 0 OR customer_id IS NOT NULL)
);
CREATE INDEX idx_inv_date     ON sales_invoices(doc_date, status);
CREATE INDEX idx_inv_customer ON sales_invoices(customer_id, doc_date);
CREATE INDEX idx_inv_status   ON sales_invoices(status);

CREATE TABLE sales_invoice_lines (
  id              TEXT PRIMARY KEY,
  invoice_id      TEXT NOT NULL REFERENCES sales_invoices(id),
  product_id      TEXT NOT NULL REFERENCES products(id),
  qty_milli       INTEGER NOT NULL CHECK (qty_milli > 0),
  rate_paisa      INTEGER NOT NULL,               -- per unit, as charged
  discount_paisa  INTEGER NOT NULL DEFAULT 0,
  line_total_paisa INTEGER NOT NULL,
  cost_paisa      INTEGER NOT NULL,               -- unit cost snapshot (weighted avg at sale)
  sort_order      INTEGER NOT NULL DEFAULT 0,
  CHECK (line_total_paisa = (qty_milli * rate_paisa) / 1000 - discount_paisa)
);
CREATE INDEX idx_lines_invoice ON sales_invoice_lines(invoice_id);
CREATE INDEX idx_lines_product ON sales_invoice_lines(product_id);

CREATE TABLE sale_returns (
  id                TEXT PRIMARY KEY,
  return_no         TEXT NOT NULL UNIQUE,          -- SR-2026-00007
  doc_date          TEXT NOT NULL,
  customer_id       TEXT NOT NULL REFERENCES customers(id),
  invoice_id        TEXT REFERENCES sales_invoices(id),   -- NULL = no-invoice return
  total_paisa       INTEGER NOT NULL,
  refund_cash_paisa INTEGER NOT NULL DEFAULT 0,
  refund_bank_paisa INTEGER NOT NULL DEFAULT 0,
  credit_note_paisa INTEGER NOT NULL DEFAULT 0,    -- reduces customer balance
  cost_total_paisa  INTEGER NOT NULL,
  reason            TEXT,
  created_at        TEXT NOT NULL,
  CHECK (total_paisa = refund_cash_paisa + refund_bank_paisa + credit_note_paisa)
);
CREATE INDEX idx_returns_date ON sale_returns(doc_date);

CREATE TABLE sale_return_lines (
  id TEXT PRIMARY KEY,
  return_id TEXT NOT NULL REFERENCES sale_returns(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  qty_milli INTEGER NOT NULL CHECK (qty_milli > 0),
  rate_paisa INTEGER NOT NULL,
  line_total_paisa INTEGER NOT NULL,
  cost_paisa INTEGER NOT NULL
);

-- ============ purchases ============
CREATE TABLE purchases (
  id                 TEXT PRIMARY KEY,
  purchase_no        TEXT NOT NULL UNIQUE,         -- PUR-2026-00011
  doc_date           TEXT NOT NULL,
  company_id         TEXT NOT NULL REFERENCES companies(id),
  supplier_invoice_no TEXT,
  subtotal_paisa     INTEGER NOT NULL,
  discount_paisa     INTEGER NOT NULL DEFAULT 0,
  freight_paisa      INTEGER NOT NULL DEFAULT 0,
  total_paisa        INTEGER NOT NULL,
  paid_cash_paisa    INTEGER NOT NULL DEFAULT 0,
  paid_bank_paisa    INTEGER NOT NULL DEFAULT 0,
  payable_paisa      INTEGER NOT NULL DEFAULT 0,
  cash_account_id    TEXT REFERENCES cash_accounts(id),
  status             TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','void')),
  void_reason TEXT, voided_at TEXT, notes TEXT,
  created_at         TEXT NOT NULL,
  CHECK (total_paisa = paid_cash_paisa + paid_bank_paisa + payable_paisa)
);
CREATE INDEX idx_pur_company ON purchases(company_id, doc_date);

CREATE TABLE purchase_lines (
  id TEXT PRIMARY KEY,
  purchase_id TEXT NOT NULL REFERENCES purchases(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  qty_milli INTEGER NOT NULL CHECK (qty_milli > 0),
  rate_paisa INTEGER NOT NULL,
  discount_paisa INTEGER NOT NULL DEFAULT 0,
  line_total_paisa INTEGER NOT NULL
);
CREATE INDEX idx_plines_purchase ON purchase_lines(purchase_id);

CREATE TABLE purchase_returns (
  id TEXT PRIMARY KEY, return_no TEXT NOT NULL UNIQUE, doc_date TEXT NOT NULL,
  company_id TEXT NOT NULL REFERENCES companies(id),
  purchase_id TEXT REFERENCES purchases(id),
  total_paisa INTEGER NOT NULL,
  refund_cash_paisa INTEGER NOT NULL DEFAULT 0,
  refund_bank_paisa INTEGER NOT NULL DEFAULT 0,
  payable_reduction_paisa INTEGER NOT NULL DEFAULT 0,
  reason TEXT, created_at TEXT NOT NULL,
  CHECK (total_paisa = refund_cash_paisa + refund_bank_paisa + payable_reduction_paisa)
);
CREATE TABLE purchase_return_lines (
  id TEXT PRIMARY KEY, return_id TEXT NOT NULL REFERENCES purchase_returns(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  qty_milli INTEGER NOT NULL CHECK (qty_milli > 0),
  rate_paisa INTEGER NOT NULL, line_total_paisa INTEGER NOT NULL
);

-- ============ payments ============
CREATE TABLE cash_accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,                             -- "Counter Cash", "Meezan Bank"
  type TEXT NOT NULL CHECK (type IN ('cash','bank')),
  bank_name TEXT, account_no TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE customer_receipts (
  id TEXT PRIMARY KEY, receipt_no TEXT NOT NULL UNIQUE, doc_date TEXT NOT NULL,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  amount_paisa INTEGER NOT NULL CHECK (amount_paisa > 0),
  mode TEXT NOT NULL CHECK (mode IN ('cash','bank','cheque')),
  cash_account_id TEXT NOT NULL REFERENCES cash_accounts(id),
  reference TEXT,                                  -- cheque no / transaction id
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','void')),
  void_reason TEXT, voided_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_receipts_customer ON customer_receipts(customer_id, doc_date);

CREATE TABLE receipt_allocations (           -- what the money was applied against
  id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL REFERENCES customer_receipts(id),
  invoice_id TEXT NOT NULL REFERENCES sales_invoices(id),
  amount_paisa INTEGER NOT NULL CHECK (amount_paisa > 0)
);
CREATE UNIQUE INDEX uq_alloc ON receipt_allocations(receipt_id, invoice_id);
CREATE INDEX idx_alloc_invoice ON receipt_allocations(invoice_id);

CREATE TABLE supplier_payments (
  id TEXT PRIMARY KEY, payment_no TEXT NOT NULL UNIQUE, doc_date TEXT NOT NULL,
  company_id TEXT NOT NULL REFERENCES companies(id),
  amount_paisa INTEGER NOT NULL CHECK (amount_paisa > 0),
  mode TEXT NOT NULL CHECK (mode IN ('cash','bank','cheque')),
  cash_account_id TEXT NOT NULL REFERENCES cash_accounts(id),
  reference TEXT, notes TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','void')),
  void_reason TEXT, voided_at TEXT,
  created_at TEXT NOT NULL
);

-- ============ expenses ============
CREATE TABLE expense_categories (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, is_active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE expenses (
  id TEXT PRIMARY KEY, doc_date TEXT NOT NULL,
  category_id TEXT NOT NULL REFERENCES expense_categories(id),
  amount_paisa INTEGER NOT NULL CHECK (amount_paisa > 0),
  cash_account_id TEXT NOT NULL REFERENCES cash_accounts(id),
  payee TEXT, notes TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','void')),
  void_reason TEXT, voided_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_exp_date ON expenses(doc_date);

-- ============ the two ledgers ============
CREATE TABLE ledger_entries (
  id           TEXT PRIMARY KEY,
  entry_date   TEXT NOT NULL,
  account_type TEXT NOT NULL CHECK (account_type IN
                 ('customer','supplier','cash','sales','cogs','inventory','expense','discount','equity')),
  account_id   TEXT,                    -- customer/company/cash-account id; NULL for nominal accounts
  debit_paisa  INTEGER NOT NULL DEFAULT 0,
  credit_paisa INTEGER NOT NULL DEFAULT 0,
  doc_type     TEXT NOT NULL,           -- sale|sale_return|purchase|purchase_return|receipt|payment|expense|adjustment|opening|void
  doc_id       TEXT NOT NULL,
  memo         TEXT,
  created_at   TEXT NOT NULL,
  CHECK (debit_paisa >= 0 AND credit_paisa >= 0),
  CHECK ((debit_paisa = 0) <> (credit_paisa = 0))    -- exactly one side, non-zero
);
CREATE INDEX idx_led_acct ON ledger_entries(account_type, account_id, entry_date);
CREATE INDEX idx_led_date ON ledger_entries(entry_date);
CREATE INDEX idx_led_doc  ON ledger_entries(doc_type, doc_id);

CREATE TABLE stock_movements (
  id            TEXT PRIMARY KEY,
  product_id    TEXT NOT NULL REFERENCES products(id),
  movement_date TEXT NOT NULL,
  type          TEXT NOT NULL CHECK (type IN
                  ('opening','purchase','sale','sale_return','purchase_return','adjustment')),
  qty_change_milli INTEGER NOT NULL,        -- signed: +in, -out
  unit_cost_paisa  INTEGER NOT NULL DEFAULT 0,
  doc_type      TEXT NOT NULL,
  doc_id        TEXT NOT NULL,
  balance_after_milli INTEGER NOT NULL,     -- running qty, written in the same batch
  note          TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_stock_product ON stock_movements(product_id, movement_date);
CREATE INDEX idx_stock_doc     ON stock_movements(doc_type, doc_id);

-- ============ infrastructure ============
CREATE TABLE doc_sequences (
  doc_type TEXT NOT NULL,             -- invoice|purchase|sale_return|purchase_return|receipt|payment
  year     INTEGER NOT NULL,
  next_no  INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (doc_type, year)
);

CREATE TABLE daily_closings (
  id TEXT PRIMARY KEY, business_date TEXT NOT NULL UNIQUE,
  opening_cash_paisa INTEGER NOT NULL, cash_in_paisa INTEGER NOT NULL,
  cash_out_paisa INTEGER NOT NULL, expected_paisa INTEGER NOT NULL,
  counted_paisa INTEGER NOT NULL, difference_paisa INTEGER NOT NULL,
  notes TEXT, created_at TEXT NOT NULL
);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY, at TEXT NOT NULL,
  user_id TEXT REFERENCES users(id),
  action TEXT NOT NULL,               -- create|void|override|login|login_failed|export
  entity_type TEXT, entity_id TEXT,
  detail_json TEXT,
  ip_hash TEXT
);
CREATE INDEX idx_audit_at ON audit_log(at);

-- Guard table: insert a row here with a failing CHECK to abort a batch (§7)
CREATE TABLE tx_guard (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL CHECK (code = 'ok'),
  detail TEXT
);
```

---

## 5. Derived values: computed, never cached (except one)

| Value | How | Why |
|---|---|---|
| **Customer outstanding** | `SUM(debit) − SUM(credit)` over `ledger_entries` for that customer | Indexed aggregate over a few hundred rows — sub-millisecond. A cached column invites drift, and drift in a credit balance is the worst possible bug |
| **Company payable** | Same, `account_type='supplier'` | — |
| **Cash / bank balance** | Same, `account_type='cash'` | — |
| **Revenue, COGS, profit** | `SUM` over nominal ledger accounts, or invoice lines for per-product margin | — |
| **`products.qty_on_hand_milli`** | **Cached, on purpose** | Needed for the guarded `UPDATE` that blocks overselling, and for fast stock screens. Maintained *only* inside stock batches; a nightly self-check recomputes from `stock_movements` and raises an alert on mismatch |

The nightly self-check is non-negotiable:

```sql
-- must return zero rows
SELECT p.id, p.name, p.qty_on_hand_milli AS cached,
       COALESCE(SUM(m.qty_change_milli), 0) AS from_movements
FROM products p LEFT JOIN stock_movements m ON m.product_id = p.id
GROUP BY p.id
HAVING cached <> from_movements;
```

Plus a ledger balance check: for every document, `SUM(debit) = SUM(credit)`.

---

## 6. Write transactions — the exact statement lists

### 6.1 Post a sale
*Example: Rs 10,000 total, 4,000 cash + 6,000 credit, 4 lines, cost 7,000.*

**Step A — read & validate (in the Worker, before the batch):**
- products: `qty_on_hand_milli`, weighted-average cost
- customer: `credit_limit_paisa`, current outstanding, `is_credit_hold`
- allocate the invoice number (§10)

**Step B — the batch:**

```sql
-- 1. header
INSERT INTO sales_invoices (id, invoice_no, doc_date, customer_id, subtotal_paisa,
  discount_paisa, total_paisa, paid_cash_paisa, paid_bank_paisa, credit_paisa,
  cost_total_paisa, cash_account_id, notes, created_at) VALUES (...);

-- 2. lines (× 4)
INSERT INTO sales_invoice_lines (id, invoice_id, product_id, qty_milli, rate_paisa,
  discount_paisa, line_total_paisa, cost_paisa, sort_order) VALUES (...);

-- 3. stock down — guarded so it can never go negative
UPDATE products SET qty_on_hand_milli = qty_on_hand_milli - ?, updated_at = ?
 WHERE id = ? AND qty_on_hand_milli >= ?;

-- 4. stock movements (× 4) with running balance
INSERT INTO stock_movements (...) VALUES (...);

-- 5. ledger: Dr cash / Dr receivable / Cr sales / Dr cogs / Cr inventory
INSERT INTO ledger_entries (...) VALUES
  ('...','2026-11-02','cash',      'acc-counter', 400000, 0,      'sale','inv-...','Cash received'),
  ('...','2026-11-02','customer',  'cust-ali',    600000, 0,      'sale','inv-...','Udhaar'),
  ('...','2026-11-02','sales',      NULL,         0,      1000000,'sale','inv-...',NULL),
  ('...','2026-11-02','cogs',       NULL,         700000, 0,      'sale','inv-...',NULL),
  ('...','2026-11-02','inventory',  NULL,         0,      700000, 'sale','inv-...',NULL);

-- 6. audit
INSERT INTO audit_log (id, at, user_id, action, entity_type, entity_id, detail_json)
VALUES (..., 'create', 'invoice', 'inv-...', '{"total":1000000,"credit":600000}');
```

### 6.2 The credit-limit guard (atomic, not advisory)

A `batch()` cannot read a result and branch on it. So the limit check is **enforced inside the transaction** using the guard table — if the invariant would break, the statement's `CHECK` fails and D1 rolls the whole batch back:

```sql
-- fails (CHECK code='ok') iff this sale would push the customer over their limit
INSERT INTO tx_guard (code, detail)
SELECT 'credit_limit_exceeded',
       'limit=' || c.credit_limit_paisa || ' outstanding=' || COALESCE(SUM(l.debit_paisa - l.credit_paisa),0)
  FROM customers c
  LEFT JOIN ledger_entries l
    ON l.account_type = 'customer' AND l.account_id = c.id
 WHERE c.id = ?
 GROUP BY c.id
HAVING (COALESCE(SUM(l.debit_paisa - l.credit_paisa), 0) + ?) > c.credit_limit_paisa
   AND c.credit_limit_paisa > 0;          -- limit 0 = unlimited
```
- **No violation** → the `SELECT` returns no rows → nothing inserted → batch proceeds.
- **Violation** → a row is inserted with `code='credit_limit_exceeded'`, the `CHECK (code='ok')` fails, and the entire sale is rolled back atomically.
- **Manager override** → the app writes an `audit_log` row with the reason and omits this guard statement, re-running the batch.

The same trick enforces oversell protection beyond the `UPDATE … AND qty >= ?` guard (a 0-row update does **not** fail a batch, so the `UPDATE` alone is not sufficient — the guard table is what makes it atomic).

### 6.3 Sale return

Same shape, mirrored: stock up, `Dr Sales / Cr Cash / Cr Receivable / Dr Inventory / Cr COGS`, plus a `sale_returns` header and lines. If `credit_note_paisa > 0` no cash moves; the customer's balance drops — which is exactly what "return it to his khata" means.

### 6.4 Post a purchase (payable created)

```sql
INSERT INTO purchases (...payable_paisa...);
INSERT INTO purchase_lines (...) VALUES (...);                 -- × n
UPDATE products SET qty_on_hand_milli = qty_on_hand_milli + ?,
       purchase_rate_paisa = ?,                                -- last cost, for the next screen
       updated_at = ? WHERE id = ?;
INSERT INTO stock_movements (...) VALUES (...);                -- × n
INSERT INTO ledger_entries (...) VALUES
  ('inventory',  debit = total, credit = 0),
  ('supplier',   debit = 0, credit = total),                   -- payable up
  ('cash',       debit = paid_cash, credit = 0) / ('supplier', debit = paid_cash);
```

Weighted-average cost recomputed here (integer maths, rounded once):

```
new_avg = (old_qty × old_avg + in_qty × in_rate) / (old_qty + in_qty)
```

### 6.5 Customer receipt (with allocation)

```sql
INSERT INTO customer_receipts (...);
INSERT INTO receipt_allocations (...) VALUES (...);   -- oldest invoices first, or manual
INSERT INTO ledger_entries (...) VALUES
  ('cash',     debit  = amount, credit = 0, doc_type='receipt'),
  ('customer', debit  = 0, credit = amount, doc_type='receipt');
```
Allocation is validated in code: `SUM(allocations) = amount`, and no allocation may exceed that invoice's remaining balance.

### 6.6 Supplier payment / expense / stock adjustment
Straightforward two-line ledger posts. Adjustment additionally requires a `reason` and reuses the negative-stock guard where it would take stock below zero.

### 6.7 Voiding a document
Never `DELETE`. Insert **reversing ledger rows and reversing stock movements** (`type` mirrors the original, sign flipped), set `status='void'`, `void_reason`, `voided_at`, and log to `audit_log`. Both the original and its reversal stay visible in every ledger, so a voided bill still explains itself a year later.

### 6.8 Opening balances (day one)
One `opening` document per source: stock quantities with cost, customer balances, company payables, cash/bank opening. All resolve to balanced ledger entries (`Dr Receivable / Cr Equity`, etc.), so the books start balanced rather than with a mysterious offset.

---

## 7. The reports, as SQL

**Company totals — the requirement**

```sql
SELECT c.id, c.name,
  COALESCE(p.total_paisa,0)  AS purchases,
  COALESCE(s.total_paisa,0)  AS sales,
  COALESCE(s.total_paisa,0) - COALESCE(s.cost_paisa,0) AS gross_profit,
  COALESCE(sl.balance,0)     AS payable
FROM companies c
LEFT JOIN (SELECT company_id, SUM(total_paisa) total_paisa FROM purchases
             WHERE status='open' AND doc_date BETWEEN ? AND ? GROUP BY company_id) p ON p.company_id=c.id
LEFT JOIN (SELECT pr.company_id, SUM(l.line_total_paisa) total_paisa, SUM(l.cost_paisa) cost_paisa
             FROM sales_invoice_lines l
             JOIN sales_invoices i ON i.id=l.invoice_id AND i.status='open'
             JOIN products pr ON pr.id=l.product_id
            WHERE i.doc_date BETWEEN ? AND ? GROUP BY pr.company_id) s ON s.company_id=c.id
LEFT JOIN (SELECT account_id, SUM(credit_paisa-debit_paisa) balance FROM ledger_entries
            WHERE account_type='supplier' GROUP BY account_id) sl ON sl.account_id=c.id
ORDER BY c.name;
```

**Customer outstanding + aging** — via `receipt_allocations`, so aging reflects *which invoice* is still unpaid, not just the net balance:

```sql
SELECT c.id, c.name,
  SUM(CASE WHEN julianday('now') - julianday(i.doc_date) <= 30 THEN bal ELSE 0 END) AS d0_30,
  SUM(CASE WHEN julianday('now') - julianday(i.doc_date) BETWEEN 31 AND 60 THEN bal ELSE 0 END) AS d31_60,
  SUM(CASE WHEN julianday('now') - julianday(i.doc_date) BETWEEN 61 AND 90 THEN bal ELSE 0 END) AS d61_90,
  SUM(CASE WHEN julianday('now') - julianday(i.doc_date) > 90 THEN bal ELSE 0 END) AS d90_plus,
  SUM(bal) AS total
FROM customers c
JOIN (
  SELECT i.id, i.customer_id, i.doc_date,
         i.total_paisa - i.paid_cash_paisa - i.paid_bank_paisa
           - COALESCE((SELECT SUM(a.amount_paisa) FROM receipt_allocations a WHERE a.invoice_id=i.id),0)
           - COALESCE((SELECT SUM(r.credit_note_paisa * r.total_paisa / NULLIF(i.total_paisa,0))
                         FROM sale_returns r WHERE r.invoice_id=i.id AND r.status='open'),0) AS bal
  FROM sales_invoices i WHERE i.status='open'
) i ON i.customer_id = c.id
GROUP BY c.id;
```

**P&L for any period** (`sales − cogs − expenses`), straight off the ledger:

```sql
SELECT
  SUM(CASE WHEN account_type='sales'   THEN credit_paisa-debit_paisa END) AS revenue,
  SUM(CASE WHEN account_type='cogs'    THEN debit_paisa-credit_paisa END) AS cogs,
  SUM(CASE WHEN account_type='expense' THEN debit_paisa-credit_paisa END) AS expenses
FROM ledger_entries WHERE entry_date BETWEEN ? AND ?;
```

---

## 8. Indexes that matter (and why)

| Index | Serves |
|---|---|
| `ledger_entries(account_type, account_id, entry_date)` | The credit panel on every bill — the single hottest query in the app |
| `sales_invoices(doc_date, status)` | Reports, day book |
| `sales_invoice_lines(invoice_id)` | Printing a bill |
| `sales_invoice_lines(product_id)` | Product-wise profit |
| `products(company_id, is_active)` | Company stock screens, purchase entry |
| `stock_movements(product_id, movement_date)` | Product history |
| `receipt_allocations(invoice_id)` | Aging |

Deliberately **not** indexed: `memo`, `notes`, `address` — write cost with no query behind it. Customer/product search uses `LIKE 'term%'` on an indexed column; at 800 products and 1,500 customers, no FTS5 needed.

---

## 9. Sizing this schema

| Table | Rows/year | Notes |
|---|---|---|
| `ledger_entries` | ~300,000 | The biggest table; one row per money movement |
| `stock_movements` | ~140,000 | |
| `sales_invoice_lines` | ~92,000 | |
| `sales_invoices` | ~23,000 | |
| everything else | < 20,000 | |

≈ **575k rows/year**, ~110 bytes each → **~65 MB/year** plus indexes ≈ **~130 MB/year**. The 500 MB free D1 limit holds **~3.5 years**; we archive closed financial years to R2 + a ZIP download at each year-end. With that, storage stops being a concern.

---

## 10. Numbering, and the gap question

Numbers are allocated with one atomic statement *before* the batch:

```sql
UPDATE doc_sequences SET next_no = next_no + 1
 WHERE doc_type='invoice' AND year=2026
RETURNING next_no;
```

- Format: `INV-2026-00042`, `PUR-2026-00011`, `SR-…`, `REC-…`, `PAY-…`.
- If the batch then fails, **that number is burned** — a gap.
- Gaps are honest but look suspicious to an accountant, so: **a "document number gaps" report** lists every gap with the reason logged at the time (validation failure, network drop). No FBR compliance here, so no legal problem — but a manager who can *explain* a gap is worth more than one who can't.
- Alternative considered and rejected: deriving the number from the row id — guarantees no gaps but hides real deletions and produces ugly numbers.

---

## 11. Things to be verified in the build, not assumed

| Question | Why it matters | Fallback |
|---|---|---|
| Does D1 roll back the **whole batch** when one statement's `CHECK` fails? | The entire guard mechanism depends on it | Test with a throwaway DB on day 1; if not, do the check + write in a `Durable Object` |
| Is `PRAGMA foreign_keys` ON in D1? | Silent orphan rows otherwise | Verify; if off, enforce in code + nightly orphan check |
| Does `julianday()` handle our date strings correctly? | Aging | Trivial to swap for `date()` arithmetic |
| Is PBKDF2 at 100k iterations under the 10 ms CPU budget? | Login usability | Measure; drop iterations, keep rate limit |
| Integer division rounding on `(qty × rate)/1000` | One-paisa line errors | Round explicitly, store the rounded value, never recompute |

---

## 12. Open questions before I build

1. **Do you want the `users` table with roles even though v1 is manager-only?** It's in the schema (one row, `role='manager'`) so adding a cashier later is a config change, not a migration. I recommend keeping it.
2. **Multiple cash/bank accounts from day one?** The schema supports them; the UI can start with one "Counter Cash" and one bank. Costs nothing to allow.
3. **Rounding display:** `Rs 1,234,567` (Western) or `Rs 12,34,567` (lakh/crore)? Confirm so it's consistent everywhere.
4. **Purchase freight/discount:** do your supplier bills come with freight or scheme discounts? Schema allows both; the UI can hide what you don't use.
