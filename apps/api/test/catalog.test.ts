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

  it('creates a product with no opening stock and records no movement', async () => {
    // The Stock screen's form defaults opening quantity to 0 -- a shop adding a
    // catalogue entry it has not bought yet should not get a phantom movement.
    const res = await post('/api/catalog/products', {
      name: 'Catalogue Only',
      companyId: 'co_tahafuz',
      category: 'other',
      purchaseRate: 0,
      saleRate: 130,
    });
    expect(res.status).toBe(201);
    const { id } = await res.json<{ id: string }>();

    const movements = await DB.prepare(
      `SELECT COUNT(*) AS n FROM stock_movements WHERE product_id = ?`,
    )
      .bind(id)
      .first<{ n: number }>();
    expect(movements!.n).toBe(0);

    const product = await DB.prepare(`SELECT qty_on_hand_milli AS q FROM products WHERE id = ?`)
      .bind(id)
      .first<{ q: number }>();
    expect(product!.q).toBe(0);
  });

  it('requires a sale rate, so a product cannot be created unbillable', async () => {
    const res = await post('/api/catalog/products', {
      name: 'No Price',
      companyId: 'co_engro',
      category: 'other',
      purchaseRate: 100,
    });
    expect(res.status).toBe(400);
  });

  it('appears in search immediately after creation', async () => {
    // This is the "No match -> Create" flow on the Purchases screen: the new
    // product has to be findable at once or the manager is left staring at the
    // same empty search box.
    const created = await post('/api/catalog/products', {
      name: 'Delta 4',
      companyId: 'co_engro',
      category: 'insecticide',
      packSize: '250 ml',
      purchaseRate: 950,
      saleRate: 1150,
      openingQty: 12,
    });
    expect(created.status).toBe(201);

    const res = await SELF.fetch('https://api.test/api/catalog/products?q=Del&limit=5', {
      headers: { Cookie: cookie },
    });
    const body = await res.json<{ products: { name: string; qty_on_hand_milli: number }[] }>();
    const found = body.products.find((p) => p.name === 'Delta 4');
    expect(found).toBeTruthy();
    expect(found!.qty_on_hand_milli).toBe(12000);
  });

  it('searches products by name prefix', async () => {
    // Creates its own fixture: with isolated storage every test starts clean.
    const created = await post('/api/catalog/products', {
      name: 'Searchable Spray 250ml',
      companyId: 'co_engro',
      category: 'insecticide',
      purchaseRate: 100,
      saleRate: 150,
    });
    expect(created.status).toBe(201);

    const res = await SELF.fetch('https://api.test/api/catalog/products?q=Searchable', {
      headers: { Cookie: cookie },
    });
    const body = await res.json<{ products: { name: string }[] }>();
    expect(body.products.some((p) => p.name === 'Searchable Spray 250ml')).toBe(true);
  });
});

describe('editing a product', () => {
  async function createProduct(body: Record<string, unknown>) {
    const res = await post('/api/catalog/products', {
      name: 'Editable',
      companyId: 'co_engro',
      category: 'insecticide',
      purchaseRate: 100,
      saleRate: 150,
      ...body,
    });
    expect(res.status).toBe(201);
    return (await res.json<{ id: string }>()).id;
  }

  function patch(path: string, body: unknown) {
    return SELF.fetch(`https://api.test${path}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify(body),
    });
  }

  it('updates name, rates, pack size and reorder level', async () => {
    const id = await createProduct({});
    const res = await patch(`/api/catalog/products/${id}`, {
      name: 'Renamed',
      saleRate: 175,
      purchaseRate: 110,
      packSize: '500 ml',
      reorderLevel: 4,
    });
    expect(res.status).toBe(200);

    const row = await DB.prepare(
      `SELECT name, sale_rate_paisa AS s, purchase_rate_paisa AS p,
              pack_size AS pk, reorder_level_milli AS r FROM products WHERE id = ?`,
    )
      .bind(id)
      .first<{ name: string; s: number; p: number; pk: string; r: number }>();
    expect(row!.name).toBe('Renamed');
    expect(row!.s).toBe(17500);
    expect(row!.p).toBe(11000);
    expect(row!.pk).toBe('500 ml');
    expect(row!.r).toBe(4000);
  });

  it('ignores quantity and company, so the count cannot be typed in', async () => {
    const id = await createProduct({ openingQty: 5 });
    // Both fields are outside the schema. A request carrying only them is a 400
    // rather than a silent no-op, which is the honest answer.
    const res = await patch(`/api/catalog/products/${id}`, {
      qtyOnHand: 9999,
      companyId: 'co_syngenta',
    });
    expect(res.status).toBe(400);

    const row = await DB.prepare(
      `SELECT qty_on_hand_milli AS q, company_id AS c FROM products WHERE id = ?`,
    )
      .bind(id)
      .first<{ q: number; c: string }>();
    expect(row!.q).toBe(5000); // 5 units, unchanged
    expect(row!.c).toBe('co_engro');
  });

  it('reports how many past lines the new rate sits beside', async () => {
    // Sold one line, so the response should acknowledge the history rather than
    // implying the change rewrites it.
    const id = await createProduct({ openingQty: 10, saleRate: 150 });
    const sale = await SELF.fetch('https://api.test/api/sales', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie, 'Idempotency-Key': 'rate-edit-1' },
      body: JSON.stringify({
        customerId: 'cust_walkin',
        lines: [{ productId: id, qty: 1, rate: 150 }],
        paidCash: 150,
        cashAccountId: 'ca_counter',
      }),
    });
    expect(sale.status).toBe(201);

    const res = await patch(`/api/catalog/products/${id}`, { saleRate: 999 });
    expect(res.status).toBe(200);
    const body = await res.json<{ affected: { saleLines: number } }>();
    expect(body.affected.saleLines).toBe(1);

    // And the invoice keeps the price it was billed at.
    const line = await DB.prepare(
      `SELECT rate_paisa AS r, line_total_paisa AS t FROM sales_invoice_lines WHERE product_id = ?`,
    )
      .bind(id)
      .first<{ r: number; t: number }>();
    expect(line!.r).toBe(15000);
    expect(line!.t).toBe(15000);
  });

  it('refuses a duplicate name within the company but 404s an unknown id', async () => {
    await createProduct({ name: 'Taken' });
    const other = await createProduct({ name: 'Free' });

    const dup = await patch(`/api/catalog/products/${other}`, { name: 'Taken' });
    expect(dup.status).toBe(409);

    const missing = await patch('/api/catalog/products/nope', { saleRate: 10 });
    expect(missing.status).toBe(404);
  });
});

describe('customers', () => {
  it('edits a customer and reports the change', async () => {
    const created = await post('/api/customers', { name: 'Editable Farmer' });
    const { id } = await created.json<{ id: string }>();

    const res = await SELF.fetch(`https://api.test/api/customers/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        name: 'Renamed Farmer',
        phone: '03001234567',
        village: 'Chak 9',
        creditLimit: 50000,
        isCreditHold: true,
      }),
    });
    expect(res.status).toBe(200);

    const row = await DB.prepare(
      `SELECT name, phone, village, credit_limit_paisa AS lim, is_credit_hold AS hold
       FROM customers WHERE id = ?`,
    )
      .bind(id)
      .first<{ name: string; phone: string; village: string; lim: number; hold: number }>();
    expect(row!.name).toBe('Renamed Farmer');
    expect(row!.phone).toBe('03001234567');
    expect(row!.village).toBe('Chak 9');
    expect(row!.lim).toBe(5000000);
    expect(row!.hold).toBe(1);
  });

  it('clears a phone and village when null is sent, but rejects an empty update', async () => {
    const created = await post('/api/customers', { name: 'Has Contact', phone: '03001112222', village: 'Chak 1' });
    const { id } = await created.json<{ id: string }>();

    const cleared = await SELF.fetch(`https://api.test/api/customers/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ phone: null, village: null }),
    });
    expect(cleared.status).toBe(200);

    const row = await DB.prepare(`SELECT phone, village FROM customers WHERE id = ?`)
      .bind(id)
      .first<{ phone: string | null; village: string | null }>();
    expect(row!.phone).toBeNull();
    expect(row!.village).toBeNull();

    const empty = await SELF.fetch(`https://api.test/api/customers/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({}),
    });
    expect(empty.status).toBe(400);
  });

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
