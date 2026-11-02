-- 0002_seed.sql
-- Baseline reference data. Safe to run once on a fresh database.

INSERT OR IGNORE INTO companies (id, name, is_active, created_at) VALUES
  ('co_tahafuz',  'Tahafuz',  1, '2026-01-01T00:00:00Z'),
  ('co_suncrop',  'SunCrop',  1, '2026-01-01T00:00:00Z'),
  ('co_engro',    'Engro',    1, '2026-01-01T00:00:00Z'),
  ('co_syngenta', 'Syngenta', 1, '2026-01-01T00:00:00Z');

INSERT OR IGNORE INTO cash_accounts (id, name, type, is_active, created_at) VALUES
  ('ca_counter', 'Counter Cash', 'cash', 1, '2026-01-01T00:00:00Z'),
  ('ca_bank',    'Bank Account', 'bank', 1, '2026-01-01T00:00:00Z');

INSERT OR IGNORE INTO expense_categories (id, name, is_active) VALUES
  ('ec_rent',      'Rent',           1),
  ('ec_utilities', 'Utilities',      1),
  ('ec_salary',    'Salaries',       1),
  ('ec_transport', 'Transport',      1),
  ('ec_tea',       'Tea / Misc',     1),
  ('ec_repairs',   'Repairs',        1),
  ('ec_license',   'Licenses / Fees',1),
  ('ec_other',     'Other',          1);

INSERT OR IGNORE INTO settings (id, shop_name, invoice_prefix, allow_negative_stock, updated_at)
VALUES (1, 'Ihsan Center', 'INV', 0, '2026-01-01T00:00:00Z');

-- One walk-in customer so anonymous counter sales always have a valid party.
INSERT OR IGNORE INTO customers (id, name, type, credit_limit_paisa, is_active, created_at)
VALUES ('cust_walkin', 'Walk-in Cash', 'walkin', 0, 1, '2026-01-01T00:00:00Z');
