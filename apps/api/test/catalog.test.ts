import { describe, it, expect, beforeAll } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { createUser } from '../src/lib/auth';

const DB = env.DB as D1Database;
let cookie = '';

beforeAll(async () => {
  await DB.prepare(`DELETE FROM users WHERE username = 'cataloguser'`).run();
  await createUser(DB, { name: 'Catalog Tester', username: 'cataloguser', password: 'catalog-pass-1' });

  const res = await SELF.fetch('https://api.test/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'cataloguser', password: 'catalog-pass-1' }),
  });
  cookie = res.headers.get('Set-Cookie')!.split(';')[0];
});

async function post(path: string, body: unknown) {
  return SELF.fetch(`https://api.test${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(body),
  });
}

describe('catalog', () => {
  it('lists the four seeded companies', async () => {
    const res = await SELF.fetch('https://api.test/api/catalog/companies', {
      headers: { Cookie: cookie },
    });
    const body = await res.json<{ companies: { name: string }[] }>();
    const names = body.companies.map((c) => c.name).sort();
    expect(names).toEqual(['Engro', 'SunCrop', 'Syngenta', 'Tahafuz']);
  });

  it('creates a product with opening stock and records the movement', async () => {
    const res = await post('/api/catalog/products', {
      name: 'Test Insecticide 500ml',
      companyId: 'co_suncrop',
      category: 'insecticide',
      packSize: '500 ml',
      purchaseRate: 450,
      saleRate: 600,
      reorderLevel: 5,
      openingQty: 40,
    });
    expect(res.status).toBe(201);
    const { id } = await res.json<{ id: string }>();

    const product = await DB.prepare(`SELECT qty_on_hand_milli AS q, avg_cost_paisa AS c FROM products WHERE id = ?`)
      .bind(id)
      .first<{ q: number; c: number }>();
    expect(product!.q).toBe(40000); // 40 units
    expect(product!.c).toBe(45000); // Rs 450 cost

    const movement = await DB.prepare(
      `SELECT type, qty_change_milli FROM stock_movements WHERE product_id = ?`,
    )
      .bind(id)
      .first<{ type: string; qty_change_milli: number }>();
    expect(movement!.type).toBe('opening');
    expect(movement!.qty_change_milli).toBe(40000);
  });

  it('refuses a duplicate product name within the same company', async () => {
    const first = await post('/api/catalog/products', {
      name: 'Duplicate Test',
      companyId: 'co_engro',
      category: 'fertilizer',
      purchaseRate: 100,
      saleRate: 120,
    });
    expect(first.status).toBe(201);

    const second = await post('/api/catalog/products', {
      name: 'Duplicate Test',
      companyId: 'co_engro',
      category: 'fertilizer',
      purchaseRate: 100,
      saleRate: 120,
    });
    expect(second.status).toBe(409);
  });

  it('allows the same product name under a different company', async () => {
    const res = await post('/api/catalog/products', {
      name: 'Duplicate Test',
      companyId: 'co_syngenta',
      category: 'fertilizer',
      purchaseRate: 100,
      saleRate: 120,
    });
    expect(res.status).toBe(201);
  });

  it('searches products by name prefix', async () => {
    const res = await SELF.fetch('https://api.test/api/catalog/products?q=Test%20Insect', {
      headers: { Cookie: cookie },
    });
    const body = await res.json<{ products: { name: string }[] }>();
    expect(body.products.some((p) => p.name === 'Test Insecticide 500ml')).toBe(true);
  });
});

describe('customers', () => {
  it('creates a customer from just a name', async () => {
    const res = await post('/api/customers', { name: 'Quick Add Farmer' });
    expect(res.status).toBe(201);
  });

  it('refuses a duplicate phone number', async () => {
    const a = await post('/api/customers', { name: 'Phone One', phone: '03001110000' });
    expect(a.status).toBe(201);

    const b = await post('/api/customers', { name: 'Phone Two', phone: '03001110000' });
    expect(b.status).toBe(409);
  });

  it('shows outstanding balance in the customer list', async () => {
    const created = await post('/api/customers', { name: 'Owes Money', creditLimit: 50000 });
    const { id } = await created.json<{ id: string }>();

    // Give them a credit balance the same way a sale would.
    await DB.batch([
      DB.prepare(
        `INSERT INTO ledger_entries (id, entry_date, account_type, account_id, debit_paisa,
           credit_paisa, doc_type, doc_id, created_at)
         VALUES ('le_test_owes', '2026-11-02', 'customer', ?, 250000, 0, 'opening', 'x', '2026-11-02T00:00:00Z')`,
      ).bind(id),
    ]);

    const res = await SELF.fetch('https://api.test/api/customers?q=Owes', {
      headers: { Cookie: cookie },
    });
    const body = await res.json<{ customers: { id: string; outstanding_paisa: number }[] }>();
    const row = body.customers.find((c) => c.id === id);
    expect(row!.outstanding_paisa).toBe(250000);
  });

  it('updates a credit limit', async () => {
    const created = await post('/api/customers', { name: 'Limit Change' });
    const { id } = await created.json<{ id: string }>();

    const res = await SELF.fetch(`https://api.test/api/customers/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ creditLimit: 75000, isCreditHold: true }),
    });
    expect(res.status).toBe(200);

    const row = await DB.prepare(`SELECT credit_limit_paisa, is_credit_hold FROM customers WHERE id = ?`)
      .bind(id)
      .first<{ credit_limit_paisa: number; is_credit_hold: number }>();
    expect(row!.credit_limit_paisa).toBe(7500000);
    expect(row!.is_credit_hold).toBe(1);
  });

  it('returns a running-balance ledger', async () => {
    const created = await post('/api/customers', { name: 'Ledger Test' });
    const { id } = await created.json<{ id: string }>();

    await DB.batch([
      DB.prepare(
        `INSERT INTO ledger_entries (id, entry_date, account_type, account_id, debit_paisa,
           credit_paisa, doc_type, doc_id, created_at)
         VALUES ('le_lt_1', '2026-11-01', 'customer', ?, 100000, 0, 'opening', 'x', '2026-11-01T00:00:00Z')`,
      ).bind(id),
      DB.prepare(
        `INSERT INTO ledger_entries (id, entry_date, account_type, account_id, debit_paisa,
           credit_paisa, doc_type, doc_id, created_at)
         VALUES ('le_lt_2', '2026-11-02', 'customer', ?, 0, 40000, 'receipt', 'y', '2026-11-02T00:00:00Z')`,
      ).bind(id),
    ]);

    const res = await SELF.fetch(`https://api.test/api/customers/${id}/ledger`, {
      headers: { Cookie: cookie },
    });
    const body = await res.json<{ entries: { running_paisa: number }[] }>();
    expect(body.entries.map((e) => e.running_paisa)).toEqual([100000, 60000]);
  });
});
