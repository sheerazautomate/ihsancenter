-- 0001_init.sql
-- Ihsan Center — core schema (D1 / SQLite)
-- Money: INTEGER paisa. Quantities: INTEGER milli-units. Soft deletes only.


-- ============ identity & configuration ============
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  iterations    INTEGER NOT NULL DEFAULT 25000,
  token_version INTEGER NOT NULL DEFAULT 1,
  role          TEXT NOT NULL DEFAULT 'manager' CHECK (role IN ('manager','clerk','accountant')),
  is_active     INTEGER NOT NULL DEFAULT 1,
  last_login_at TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE settings (
  id                     INTEGER PRIMARY KEY CHECK (id = 1),
  shop_name              TEXT NOT NULL DEFAULT 'Ihsan Center',
  address                TEXT,
  phone                  TEXT,
  logo_url               TEXT,
  receipt_footer         TEXT,
  invoice_prefix         TEXT NOT NULL DEFAULT 'INV',
  allow_negative_stock   INTEGER NOT NULL DEFAULT 0,
  low_stock_default_milli INTEGER NOT NULL DEFAULT 0,
  updated_at             TEXT NOT NULL
);

-- ============ master data ============
CREATE TABLE companies (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL UNIQUE,
  contact_person TEXT,
  phone          TEXT,
  address        TEXT,
  notes          TEXT,
  is_active      INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL
);

CREATE TABLE products (
  id                  TEXT PRIMARY KEY,
  company_id          TEXT NOT NULL REFERENCES companies(id),
  name                TEXT NOT NULL,
  sku                 TEXT,
  barcode             TEXT,
  category            TEXT NOT NULL CHECK (category IN
                        ('insecticide','fungicide','herbicide','fertilizer','seed','other')),
  unit                TEXT NOT NULL DEFAULT 'pcs',
  pack_size           TEXT,
  purchase_rate_paisa INTEGER NOT NULL DEFAULT 0,
  sale_rate_paisa     INTEGER NOT NULL DEFAULT 0,
  avg_cost_paisa      INTEGER NOT NULL DEFAULT 0,
  reorder_level_milli INTEGER NOT NULL DEFAULT 0,
  qty_on_hand_milli   INTEGER NOT NULL DEFAULT 0,
  is_active           INTEGER NOT NULL DEFAULT 1,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  UNIQUE (company_id, name)
);
CREATE INDEX idx_products_company ON products(company_id, is_active);
CREATE INDEX idx_products_name    ON products(name);
CREATE INDEX idx_products_sku     ON products(sku);
CREATE INDEX idx_products_barcode ON products(barcode);

CREATE TABLE customers (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  phone              TEXT,
  village            TEXT,
  address            TEXT,
  type               TEXT NOT NULL DEFAULT 'farmer' CHECK (type IN ('farmer','dealer','walkin')),
  credit_limit_paisa INTEGER NOT NULL DEFAULT 0,
  is_credit_hold     INTEGER NOT NULL DEFAULT 0,
  notes              TEXT,
  is_active          INTEGER NOT NULL DEFAULT 1,
  created_at         TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_customers_phone ON customers(phone) WHERE phone IS NOT NULL;
CREATE INDEX idx_customers_name ON customers(name);

CREATE TABLE cash_accounts (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  type       TEXT NOT NULL CHECK (type IN ('cash','bank')),
  bank_name  TEXT,
  account_no TEXT,
  is_active  INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE expense_categories (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL UNIQUE,
  is_active INTEGER NOT NULL DEFAULT 1
);

-- ============ sales ============
CREATE TABLE sales_invoices (
  id               TEXT PRIMARY KEY,
  invoice_no       TEXT NOT NULL UNIQUE,
  doc_date         TEXT NOT NULL,
  customer_id      TEXT NOT NULL REFERENCES customers(id),
  subtotal_paisa   INTEGER NOT NULL,
  discount_paisa   INTEGER NOT NULL DEFAULT 0,
  total_paisa      INTEGER NOT NULL,
  paid_cash_paisa  INTEGER NOT NULL DEFAULT 0,
  paid_bank_paisa  INTEGER NOT NULL DEFAULT 0,
  credit_paisa     INTEGER NOT NULL DEFAULT 0,
  cost_total_paisa INTEGER NOT NULL,
  cash_account_id  TEXT REFERENCES cash_accounts(id),
  bank_account_id  TEXT REFERENCES cash_accounts(id),
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','void')),
  void_reason      TEXT,
  voided_at        TEXT,
  notes            TEXT,
  created_at       TEXT NOT NULL,
  CHECK (total_paisa = paid_cash_paisa + paid_bank_paisa + credit_paisa),
  CHECK (total_paisa >= 0)
);
CREATE INDEX idx_inv_date     ON sales_invoices(doc_date, status);
CREATE INDEX idx_inv_customer ON sales_invoices(customer_id, doc_date);
CREATE INDEX idx_inv_status   ON sales_invoices(status);

CREATE TABLE sales_invoice_lines (
  id               TEXT PRIMARY KEY,
  invoice_id       TEXT NOT NULL REFERENCES sales_invoices(id),
  product_id       TEXT NOT NULL REFERENCES products(id),
  qty_milli        INTEGER NOT NULL CHECK (qty_milli > 0),
  rate_paisa       INTEGER NOT NULL CHECK (rate_paisa >= 0),
  discount_paisa   INTEGER NOT NULL DEFAULT 0 CHECK (discount_paisa >= 0),
  line_total_paisa INTEGER NOT NULL CHECK (line_total_paisa >= 0),
  cost_paisa       INTEGER NOT NULL,
  sort_order       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_lines_invoice ON sales_invoice_lines(invoice_id);
CREATE INDEX idx_lines_product ON sales_invoice_lines(product_id);

CREATE TABLE sale_returns (
  id                TEXT PRIMARY KEY,
  return_no         TEXT NOT NULL UNIQUE,
  doc_date          TEXT NOT NULL,
  customer_id       TEXT NOT NULL REFERENCES customers(id),
  invoice_id        TEXT REFERENCES sales_invoices(id),
  total_paisa       INTEGER NOT NULL,
  cost_total_paisa  INTEGER NOT NULL,
  refund_cash_paisa INTEGER NOT NULL DEFAULT 0,
  refund_bank_paisa INTEGER NOT NULL DEFAULT 0,
  credit_note_paisa INTEGER NOT NULL DEFAULT 0,
  cash_account_id   TEXT REFERENCES cash_accounts(id),
  bank_account_id   TEXT REFERENCES cash_accounts(id),
  reason            TEXT,
  status            TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','void')),
  void_reason       TEXT,
  voided_at         TEXT,
  created_at        TEXT NOT NULL,
  CHECK (total_paisa = refund_cash_paisa + refund_bank_paisa + credit_note_paisa)
);
CREATE INDEX idx_returns_date     ON sale_returns(doc_date);
CREATE INDEX idx_returns_customer ON sale_returns(customer_id, doc_date);

CREATE TABLE sale_return_lines (
  id               TEXT PRIMARY KEY,
  return_id        TEXT NOT NULL REFERENCES sale_returns(id),
  product_id       TEXT NOT NULL REFERENCES products(id),
  qty_milli        INTEGER NOT NULL CHECK (qty_milli > 0),
  rate_paisa       INTEGER NOT NULL,
  discount_paisa   INTEGER NOT NULL DEFAULT 0,
  line_total_paisa INTEGER NOT NULL,
  cost_paisa       INTEGER NOT NULL
);
CREATE INDEX idx_rlines_return ON sale_return_lines(return_id);

-- ============ purchases ============
CREATE TABLE purchases (
  id                  TEXT PRIMARY KEY,
  purchase_no         TEXT NOT NULL UNIQUE,
  doc_date            TEXT NOT NULL,
  company_id          TEXT NOT NULL REFERENCES companies(id),
  supplier_invoice_no TEXT,
  subtotal_paisa      INTEGER NOT NULL,
  discount_paisa      INTEGER NOT NULL DEFAULT 0,
  freight_paisa       INTEGER NOT NULL DEFAULT 0,
  total_paisa         INTEGER NOT NULL,
  paid_cash_paisa     INTEGER NOT NULL DEFAULT 0,
  paid_bank_paisa     INTEGER NOT NULL DEFAULT 0,
  payable_paisa       INTEGER NOT NULL DEFAULT 0,
  cash_account_id     TEXT REFERENCES cash_accounts(id),
  bank_account_id     TEXT REFERENCES cash_accounts(id),
  status              TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','void')),
  void_reason         TEXT,
  voided_at           TEXT,
  notes               TEXT,
  created_at          TEXT NOT NULL,
  CHECK (total_paisa = paid_cash_paisa + paid_bank_paisa + payable_paisa)
);
CREATE INDEX idx_pur_company ON purchases(company_id, doc_date);

CREATE TABLE purchase_lines (
  id               TEXT PRIMARY KEY,
  purchase_id      TEXT NOT NULL REFERENCES purchases(id),
  product_id       TEXT NOT NULL REFERENCES products(id),
  qty_milli        INTEGER NOT NULL CHECK (qty_milli > 0),
  rate_paisa       INTEGER NOT NULL,
  discount_paisa   INTEGER NOT NULL DEFAULT 0,
  line_total_paisa INTEGER NOT NULL
);
CREATE INDEX idx_plines_purchase ON purchase_lines(purchase_id);
CREATE INDEX idx_plines_product  ON purchase_lines(product_id);

CREATE TABLE purchase_returns (
  id                      TEXT PRIMARY KEY,
  return_no               TEXT NOT NULL UNIQUE,
  doc_date                TEXT NOT NULL,
  company_id              TEXT NOT NULL REFERENCES companies(id),
  purchase_id             TEXT REFERENCES purchases(id),
  total_paisa             INTEGER NOT NULL,
  refund_cash_paisa       INTEGER NOT NULL DEFAULT 0,
  refund_bank_paisa       INTEGER NOT NULL DEFAULT 0,
  payable_reduction_paisa INTEGER NOT NULL DEFAULT 0,
  reason                  TEXT,
  status                  TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','void')),
  void_reason             TEXT,
  voided_at               TEXT,
  created_at              TEXT NOT NULL,
  CHECK (total_paisa = refund_cash_paisa + refund_bank_paisa + payable_reduction_paisa)
);

CREATE TABLE purchase_return_lines (
  id               TEXT PRIMARY KEY,
  return_id        TEXT NOT NULL REFERENCES purchase_returns(id),
  product_id       TEXT NOT NULL REFERENCES products(id),
  qty_milli        INTEGER NOT NULL CHECK (qty_milli > 0),
  rate_paisa       INTEGER NOT NULL,
  line_total_paisa INTEGER NOT NULL
);

-- ============ payments ============
CREATE TABLE customer_receipts (
  id              TEXT PRIMARY KEY,
  receipt_no      TEXT NOT NULL UNIQUE,
  doc_date        TEXT NOT NULL,
  customer_id     TEXT NOT NULL REFERENCES customers(id),
  amount_paisa    INTEGER NOT NULL CHECK (amount_paisa > 0),
  mode            TEXT NOT NULL CHECK (mode IN ('cash','bank','cheque')),
  cash_account_id TEXT NOT NULL REFERENCES cash_accounts(id),
  reference       TEXT,
  notes           TEXT,
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','void')),
  void_reason     TEXT,
  voided_at       TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_receipts_customer ON customer_receipts(customer_id, doc_date);

CREATE TABLE receipt_allocations (
  id           TEXT PRIMARY KEY,
  receipt_id   TEXT NOT NULL REFERENCES customer_receipts(id),
  invoice_id   TEXT NOT NULL REFERENCES sales_invoices(id),
  amount_paisa INTEGER NOT NULL CHECK (amount_paisa > 0)
);
CREATE UNIQUE INDEX uq_alloc ON receipt_allocations(receipt_id, invoice_id);
CREATE INDEX idx_alloc_invoice ON receipt_allocations(invoice_id);

CREATE TABLE supplier_payments (
  id              TEXT PRIMARY KEY,
  payment_no      TEXT NOT NULL UNIQUE,
  doc_date        TEXT NOT NULL,
  company_id      TEXT NOT NULL REFERENCES companies(id),
  amount_paisa    INTEGER NOT NULL CHECK (amount_paisa > 0),
  mode            TEXT NOT NULL CHECK (mode IN ('cash','bank','cheque')),
  cash_account_id TEXT NOT NULL REFERENCES cash_accounts(id),
  reference       TEXT,
  notes           TEXT,
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','void')),
  void_reason     TEXT,
  voided_at       TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_spay_company ON supplier_payments(company_id, doc_date);

-- ============ expenses ============
CREATE TABLE expenses (
  id              TEXT PRIMARY KEY,
  doc_date        TEXT NOT NULL,
  category_id     TEXT NOT NULL REFERENCES expense_categories(id),
  amount_paisa    INTEGER NOT NULL CHECK (amount_paisa > 0),
  cash_account_id TEXT NOT NULL REFERENCES cash_accounts(id),
  payee           TEXT,
  notes           TEXT,
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','void')),
  void_reason     TEXT,
  voided_at       TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_exp_date ON expenses(doc_date);

-- ============ ledgers ============
CREATE TABLE ledger_entries (
  id           TEXT PRIMARY KEY,
  entry_date   TEXT NOT NULL,
  account_type TEXT NOT NULL CHECK (account_type IN
                 ('customer','supplier','cash','sales','sale_return','cogs','inventory','expense','discount','equity')),
  account_id   TEXT,
  debit_paisa  INTEGER NOT NULL DEFAULT 0,
  credit_paisa INTEGER NOT NULL DEFAULT 0,
  doc_type     TEXT NOT NULL,
  doc_id       TEXT NOT NULL,
  memo         TEXT,
  created_at   TEXT NOT NULL,
  CHECK (debit_paisa >= 0 AND credit_paisa >= 0),
  CHECK ((debit_paisa = 0) <> (credit_paisa = 0))
);
CREATE INDEX idx_led_acct ON ledger_entries(account_type, account_id, entry_date);
CREATE INDEX idx_led_date ON ledger_entries(entry_date);
CREATE INDEX idx_led_doc  ON ledger_entries(doc_type, doc_id);

CREATE TABLE stock_movements (
  id                  TEXT PRIMARY KEY,
  product_id          TEXT NOT NULL REFERENCES products(id),
  movement_date       TEXT NOT NULL,
  type                TEXT NOT NULL CHECK (type IN
                        ('opening','purchase','sale','sale_return','purchase_return','adjustment')),
  qty_change_milli    INTEGER NOT NULL,
  unit_cost_paisa     INTEGER NOT NULL DEFAULT 0,
  doc_type            TEXT NOT NULL,
  doc_id              TEXT NOT NULL,
  balance_after_milli INTEGER NOT NULL,
  note                TEXT,
  created_at          TEXT NOT NULL
);
CREATE INDEX idx_stock_product ON stock_movements(product_id, movement_date);
CREATE INDEX idx_stock_doc     ON stock_movements(doc_type, doc_id);

-- ============ infrastructure ============
CREATE TABLE doc_sequences (
  doc_type TEXT NOT NULL,
  year     INTEGER NOT NULL,
  next_no  INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (doc_type, year)
);

CREATE TABLE daily_closings (
  id                  TEXT PRIMARY KEY,
  business_date       TEXT NOT NULL UNIQUE,
  opening_cash_paisa  INTEGER NOT NULL,
  cash_in_paisa       INTEGER NOT NULL,
  cash_out_paisa      INTEGER NOT NULL,
  expected_paisa      INTEGER NOT NULL,
  counted_paisa       INTEGER NOT NULL,
  difference_paisa    INTEGER NOT NULL,
  notes               TEXT,
  created_at          TEXT NOT NULL
);

CREATE TABLE audit_log (
  id          TEXT PRIMARY KEY,
  at          TEXT NOT NULL,
  user_id     TEXT,
  action      TEXT NOT NULL,
  entity_type TEXT,
  entity_id   TEXT,
  detail_json TEXT,
  ip_hash     TEXT
);
CREATE INDEX idx_audit_at ON audit_log(at);
CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id);

-- Abort-a-batch guard. Insert a row here with a non-'ok' code and the
-- CHECK constraint fails, rolling back the whole D1 batch. See src/lib/guard.ts
CREATE TABLE tx_guard (
  id     INTEGER PRIMARY KEY,
  code   TEXT NOT NULL CHECK (code = 'ok'),
  detail TEXT
);
