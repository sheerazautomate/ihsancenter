import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { getOpeningState, postOpeningBalances } from '../src/lib/opening';
import { rupeesToPaisa, qtyToMilli } from '../src/lib/money';

const DB = env.DB as D1Database;

const CUSTOMER = 'cust_open';
const CUSTOMER2 = 'cust_open2';
const PRODUCT = 'prod_open';
const COMPANY = 'co_engro';

beforeEach(async () => {
  const tables = [
    'tx_guard', 'audit_log', 'ledger_entries', 'stock_movements', 'doc_sequences',
    'sales_invoice_lines', 'sales_invoices',
  ];
  for (const t of tables) await DB.prepare(`DELETE FROM ${t}`).run();
  await DB.prepare(`DELETE FROM products`).run();
  await DB.prepare(`DELETE FROM customers`).run();

  await DB.batch([
    DB.prepare(
      `INSERT INTO customers (id, name, type, created_at)
       VALUES (?, 'Opening Customer', 'farmer', '2026-01-01T00:00:00Z')`,
    ).bind(CUSTOMER),
    DB.prepare(
      `INSERT INTO customers (id, name, type, created_at)
       VALUES (?, 'Second Customer', 'farmer', '2026-01-01T00:00:00Z')`,
    ).bind(CUSTOMER2),
    DB.prepare(
      `INSERT OR IGNORE INTO customers (id, name, type, created_at)
       VALUES ('cust_walkin', 'Walk-in Customer', 'walkin', '2026-01-01T00:00:00Z')`,
    ),
    DB.prepare(
      `INSERT OR REPLACE INTO products (id, company_id, name, category, purchase_rate_paisa,
         sale_rate_paisa, avg_cost_paisa, qty_on_hand_milli, created_at, updated_at)
       VALUES (?, ?, 'Opening Product', 'fertilizer', 100000, 120000, 100000, 0,
               '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    ).bind(PRODUCT, COMPANY),
  ]);

  // opening balances for cash accounts so the tests are not affected by prior runs
  await DB.prepare(`DELETE FROM ledger_entries WHERE account_type = 'cash'`).run();
});

async function ledgerBalance(accountType: string, accountId: string | null): Promise<number> {
  const row = await DB.prepare(
    `SELECT COALESCE(SUM(debit_paisa - credit_paisa), 0) AS b FROM ledger_entries
     WHERE account_type = ? AND account_id IS ?`,
  )
    .bind(accountType, accountId)
    .first<{ b: number }>();
  return row!.b;
}

async function unbalancedDocs() {
  const res = await DB.prepare(
    `SELECT doc_id, SUM(debit_paisa) AS dr, SUM(credit_paisa) AS cr
     FROM ledger_entries GROUP BY doc_id HAVING dr <> cr`,
  ).all();
  return res.results ?? [];
}

describe('opening balances', () => {
  it('posts customer, supplier, cash and stock and balances to capital', async () => {
    const result = await postOpeningBalances(DB, {
      docDate: '2026-11-01',
      customers: [{ customerId: CUSTOMER, amountPaisa: rupeesToPaisa(25000) }],
      suppliers: [{ companyId: COMPANY, amountPaisa: rupeesToPaisa(90000) }],
      cash: [{ cashAccountId: 'ca_counter', amountPaisa: rupeesToPaisa(15000) }],
      stock: [{ productId: PRODUCT, qtyMilli: qtyToMilli(20), unitCostPaisa: rupeesToPaisa(1000) }],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // assets 25,000 + 15,000 + 20,000 = 60,000; liabilities 90,000;
    // so the owner's stake is negative — the shop owes more than it holds
    expect(result.totals.capitalPaisa).toBe(-rupeesToPaisa(30000));
    expect(result.totals.receivablePaisa).toBe(rupeesToPaisa(25000));
    expect(result.totals.payablePaisa).toBe(rupeesToPaisa(90000));

    expect(await ledgerBalance('customer', CUSTOMER)).toBe(rupeesToPaisa(25000));
    expect(await ledgerBalance('supplier', COMPANY)).toBe(-rupeesToPaisa(90000));
    expect(await ledgerBalance('cash', 'ca_counter')).toBe(rupeesToPaisa(15000));
    expect(await ledgerBalance('inventory', null)).toBe(rupeesToPaisa(20000));
    // negative net assets => capital carries a debit balance (the shop owed more
    // than it owned on day one). Every account sums to zero across the batch.
    expect(await ledgerBalance('equity', null)).toBe(rupeesToPaisa(30000));

    expect(await unbalancedDocs()).toEqual([]);
  });

  it('adds stock to the product and records an opening movement', async () => {
    await postOpeningBalances(DB, {
      docDate: '2026-11-01',
      stock: [{ productId: PRODUCT, qtyMilli: qtyToMilli(35), unitCostPaisa: rupeesToPaisa(950) }],
    });

    const product = await DB.prepare(
      `SELECT qty_on_hand_milli AS q, avg_cost_paisa AS c FROM products WHERE id = ?`,
    )
      .bind(PRODUCT)
      .first<{ q: number; c: number }>();
    expect(product!.q).toBe(qtyToMilli(35));
    expect(product!.c).toBe(rupeesToPaisa(950));

    const movement = await DB.prepare(
      `SELECT type, qty_change_milli, balance_after_milli FROM stock_movements WHERE product_id = ?`,
    )
      .bind(PRODUCT)
      .first<{ type: string; qty_change_milli: number; balance_after_milli: number }>();
    expect(movement!.type).toBe('opening');
    expect(movement!.qty_change_milli).toBe(qtyToMilli(35));
    expect(movement!.balance_after_milli).toBe(qtyToMilli(35));
  });

  it('treats a negative customer balance as an advance', async () => {
    await postOpeningBalances(DB, {
      docDate: '2026-11-01',
      customers: [{ customerId: CUSTOMER, amountPaisa: -rupeesToPaisa(5000) }],
      cash: [{ cashAccountId: 'ca_counter', amountPaisa: rupeesToPaisa(5000) }],
    });

    // the shop owes them: credit balance
    expect(await ledgerBalance('customer', CUSTOMER)).toBe(-rupeesToPaisa(5000));
    expect(await unbalancedDocs()).toEqual([]);
  });

  it('refuses to post an account twice', async () => {
    const first = await postOpeningBalances(DB, {
      docDate: '2026-11-01',
      customers: [{ customerId: CUSTOMER, amountPaisa: rupeesToPaisa(1000) }],
    });
    expect(first.ok).toBe(true);

    const second = await postOpeningBalances(DB, {
      docDate: '2026-11-02',
      customers: [{ customerId: CUSTOMER, amountPaisa: rupeesToPaisa(9999) }],
      cash: [{ cashAccountId: 'ca_counter', amountPaisa: rupeesToPaisa(500) }],
    });

    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe('opening_already_posted');

    // nothing from the second attempt was written, including the cash line
    expect(await ledgerBalance('customer', CUSTOMER)).toBe(rupeesToPaisa(1000));
    expect(await ledgerBalance('cash', 'ca_counter')).toBe(0);
  });

  it('refuses to post opening stock twice for the same product', async () => {
    await postOpeningBalances(DB, {
      docDate: '2026-11-01',
      stock: [{ productId: PRODUCT, qtyMilli: qtyToMilli(10), unitCostPaisa: rupeesToPaisa(100) }],
    });

    const second = await postOpeningBalances(DB, {
      docDate: '2026-11-02',
      stock: [{ productId: PRODUCT, qtyMilli: qtyToMilli(10), unitCostPaisa: rupeesToPaisa(100) }],
    });
    expect(second.ok).toBe(false);

    const product = await DB.prepare(`SELECT qty_on_hand_milli AS q FROM products WHERE id = ?`)
      .bind(PRODUCT)
      .first<{ q: number }>();
    expect(product!.q).toBe(qtyToMilli(10)); // counted once
  });

  it('allows opening a second customer later without touching the first', async () => {
    await postOpeningBalances(DB, {
      docDate: '2026-11-01',
      customers: [{ customerId: CUSTOMER, amountPaisa: rupeesToPaisa(1000) }],
    });

    const second = await postOpeningBalances(DB, {
      docDate: '2026-11-02',
      customers: [{ customerId: CUSTOMER2, amountPaisa: rupeesToPaisa(3000) }],
    });
    expect(second.ok).toBe(true);

    expect(await ledgerBalance('customer', CUSTOMER)).toBe(rupeesToPaisa(1000));
    expect(await ledgerBalance('customer', CUSTOMER2)).toBe(rupeesToPaisa(3000));
  });

  it('rejects unknown ids rather than writing orphans', async () => {
    const result = await postOpeningBalances(DB, {
      docDate: '2026-11-01',
      customers: [{ customerId: 'does_not_exist', amountPaisa: rupeesToPaisa(100) }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Customer not found/i);
  });

  it('rejects an empty submission', async () => {
    const result = await postOpeningBalances(DB, { docDate: '2026-11-01', customers: [] });
    expect(result.ok).toBe(false);
  });

  it('nets to zero cleanly when assets equal liabilities', async () => {
    const result = await postOpeningBalances(DB, {
      docDate: '2026-11-01',
      customers: [{ customerId: CUSTOMER, amountPaisa: rupeesToPaisa(10000) }],
      suppliers: [{ companyId: COMPANY, amountPaisa: rupeesToPaisa(10000) }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.totals.capitalPaisa).toBe(0);
    // no equity line needed at all when it balances on its own
    const equity = await DB.prepare(
      `SELECT COUNT(*) AS n FROM ledger_entries WHERE account_type = 'equity'`,
    ).first<{ n: number }>();
    expect(equity!.n).toBe(0);
    expect(await unbalancedDocs()).toEqual([]);
  });
});

describe('opening state', () => {
  it('reports what has been posted so the screen can show it', async () => {
    await postOpeningBalances(DB, {
      docDate: '2026-11-01',
      customers: [{ customerId: CUSTOMER, amountPaisa: rupeesToPaisa(7500) }],
      cash: [{ cashAccountId: 'ca_counter', amountPaisa: rupeesToPaisa(2000) }],
      stock: [{ productId: PRODUCT, qtyMilli: qtyToMilli(5), unitCostPaisa: rupeesToPaisa(1000) }],
    });

    const state = await getOpeningState(DB);

    expect(state.posted).toBe(true);
    expect(state.firstOpeningDate).toBe('2026-11-01');
    expect(state.totals.receivablePaisa).toBe(rupeesToPaisa(7500));
    expect(state.totals.cashPaisa).toBe(rupeesToPaisa(2000));
    expect(state.totals.inventoryPaisa).toBe(rupeesToPaisa(5000));

    const customerRow = state.customers.find((c) => c.id === CUSTOMER);
    expect(customerRow!.amountPaisa).toBe(rupeesToPaisa(7500));
    // the walk-in customer is excluded from the list
    expect(state.customers.some((c) => c.id === 'cust_walkin')).toBe(false);
  });

  it('starts empty on a fresh database', async () => {
    const state = await getOpeningState(DB);
    expect(state.posted).toBe(false);
    expect(state.firstOpeningDate).toBeNull();
    expect(state.totals.receivablePaisa).toBe(0);
  });
});
