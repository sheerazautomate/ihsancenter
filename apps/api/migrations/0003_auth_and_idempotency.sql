-- 0003_auth_and_idempotency.sql
-- Session/attempt tracking, and atomic idempotency keys on posted documents.

-- Rate limiting for login. Keyed by username+IP hash, never stores raw IPs.
CREATE TABLE login_attempts (
  id            TEXT PRIMARY KEY,
  at            TEXT NOT NULL,
  username      TEXT NOT NULL,
  ip_hash       TEXT,
  succeeded     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_attempts_user ON login_attempts(username, at);
CREATE INDEX idx_attempts_ip   ON login_attempts(ip_hash, at);

-- Idempotency keys.
--
-- This is the reason a double-tapped "Save bill" on a slow phone cannot create
-- two invoices: the key is a UNIQUE column on the document itself, so the second
-- insert fails the unique constraint and the whole batch rolls back atomically.
-- No check-then-write window exists. The stored response lets a genuine retry
-- (network dropped after commit) get the original invoice back instead of an error.
ALTER TABLE sales_invoices      ADD COLUMN idempotency_key TEXT;
ALTER TABLE purchases           ADD COLUMN idempotency_key TEXT;
ALTER TABLE customer_receipts   ADD COLUMN idempotency_key TEXT;
ALTER TABLE supplier_payments   ADD COLUMN idempotency_key TEXT;
ALTER TABLE expenses            ADD COLUMN idempotency_key TEXT;
ALTER TABLE sale_returns        ADD COLUMN idempotency_key TEXT;

CREATE UNIQUE INDEX uq_invoice_idem     ON sales_invoices(idempotency_key)    WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX uq_purchase_idem    ON purchases(idempotency_key)         WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX uq_receipt_idem     ON customer_receipts(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX uq_suppay_idem      ON supplier_payments(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX uq_expense_idem     ON expenses(idempotency_key)          WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX uq_salereturn_idem  ON sale_returns(idempotency_key)      WHERE idempotency_key IS NOT NULL;
