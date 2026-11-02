-- 0004_demo_seed.sql
-- Demonstration data for local development only.
-- DO NOT apply this to the production database: it would put fake stock and
-- fake customer balances into real books.
--
-- Apply with: npm run db:reset:local (which includes this file)
-- Skip on production: only run 0001-0003 there.

-- ---------- customers ----------
INSERT INTO customers (id, name, phone, village, type, credit_limit_paisa, created_at) VALUES
  ('cust_ali',    'Ali Muhammad',       '03001234567', 'Chak 42',      'farmer', 5000000,  '2026-01-01T00:00:00Z'),
  ('cust_ravi',   'Ravi Chand',         '03009876543', 'Kot Radha',    'farmer', 3000000,  '2026-01-01T00:00:00Z'),
  ('cust_dealer', 'Chaudhry Agri Store','03335556677', 'Main Bazaar',  'dealer', 20000000, '2026-01-01T00:00:00Z'),
  ('cust_nazir',  'Nazir Ahmed',        '03451112233', 'Basti Malook', 'farmer', 0,        '2026-01-01T00:00:00Z');

-- ---------- products ----------
-- (id, company, name, category, pack, cost_paisa, sale_paisa, stock_milli)
INSERT INTO products (id, company_id, name, sku, category, unit, pack_size,
  purchase_rate_paisa, sale_rate_paisa, avg_cost_paisa, reorder_level_milli,
  qty_on_hand_milli, created_at, updated_at) VALUES
  ('prod_t1', 'co_tahafuz',  'Kan Ram 500ml',        'TF-001', 'insecticide', 'bottle', '500 ml',  42000, 55000,  42000, 10000, 48000,  '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  ('prod_t2', 'co_tahafuz',  'Power 20 WP 250g',     'TF-002', 'insecticide', 'sachet', '250 g',   65000, 85000,  65000,  5000, 24000,  '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  ('prod_s1', 'co_suncrop',  'Sunphos 1L',           'SC-001', 'insecticide', 'bottle', '1 L',     98000, 125000, 98000, 10000, 36000,  '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  ('prod_s2', 'co_suncrop',  'Sunzeb 500g',          'SC-002', 'fungicide',   'pack',   '500 g',   72000, 95000,  72000,  5000, 18000,  '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  ('prod_e1', 'co_engro',    'Engro Urea 50kg',      'EN-001', 'fertilizer',  'bag',    '50 kg',  1150000, 1320000, 1150000, 200000, 1500000, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  ('prod_e2', 'co_engro',    'Zarkhez 25kg',         'EN-002', 'fertilizer',  'bag',    '25 kg',   420000, 490000, 420000, 100000, 400000, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  ('prod_sy1','co_syngenta', 'Dual Gold 1L',         'SY-001', 'herbicide',   'bottle', '1 L',    145000, 185000, 145000, 10000, 30000,  '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  ('prod_sy2','co_syngenta', 'Tilt 250 EC 250ml',    'SY-002', 'fungicide',   'bottle', '250 ml', 168000, 210000, 168000,  5000, 12000,  '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  ('prod_sy3','co_syngenta', 'Actara 25WG 100g',     'SY-003', 'insecticide', 'pack',   '100 g',  210000, 260000, 210000,  3000,  2000,  '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');

-- opening stock movements so the stock ledger reconciles from day one
INSERT INTO stock_movements (id, product_id, movement_date, type, qty_change_milli,
  unit_cost_paisa, doc_type, doc_id, balance_after_milli, note, created_at)
SELECT 'sm_open_' || p.id, p.id, date('now', '-30 days'), 'opening', p.qty_on_hand_milli,
       p.avg_cost_paisa, 'opening', p.id, p.qty_on_hand_milli, 'Opening stock', datetime('now')
FROM products p;

-- ---------- an opening balance for one customer, so the credit panel has history ----------
-- Ali Muhammad already owes Rs 12,000 from last season.
INSERT INTO ledger_entries (id, entry_date, account_type, account_id, debit_paisa, credit_paisa,
  doc_type, doc_id, memo, created_at) VALUES
  ('le_open_ali_dr', date('now', '-45 days'), 'customer', 'cust_ali', 1200000, 0, 'opening', 'opening_ali', 'Opening balance', datetime('now')),
  ('le_open_ali_cr', date('now', '-45 days'), 'equity',   NULL,       0, 1200000, 'opening', 'opening_ali', 'Opening balance', datetime('now'));

-- ---------- expense categories are already seeded in 0002 ----------
INSERT INTO expenses (id, doc_date, category_id, amount_paisa, cash_account_id, payee, notes, created_at) VALUES
  ('exp_1', date('now', '-5 days'), 'ec_utilities', 1850000, 'ca_counter', 'LESCO', 'Electricity bill', datetime('now')),
  ('exp_2', date('now', '-3 days'), 'ec_tea',        45000, 'ca_counter', 'Tea stall', NULL, datetime('now'));

INSERT INTO ledger_entries (id, entry_date, account_type, account_id, debit_paisa, credit_paisa,
  doc_type, doc_id, memo, created_at) VALUES
  ('le_exp1_dr', date('now','-5 days'), 'expense', NULL,       1850000, 0, 'expense', 'exp_1', 'Electricity bill', datetime('now')),
  ('le_exp1_cr', date('now','-5 days'), 'cash',    'ca_counter', 0, 1850000, 'expense', 'exp_1', 'Electricity bill', datetime('now')),
  ('le_exp2_dr', date('now','-3 days'), 'expense', NULL,         45000, 0, 'expense', 'exp_2', 'Tea / misc', datetime('now')),
  ('le_exp2_cr', date('now','-3 days'), 'cash',    'ca_counter', 0,   45000, 'expense', 'exp_2', 'Tea / misc', datetime('now'));
