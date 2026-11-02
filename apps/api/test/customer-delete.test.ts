import { describe, it, expect, beforeAll } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { createUser } from '../src/lib/auth';

const DB = env.DB as D1Database;
let cookie = '';
// Tests run against the migrations only (the demo seed is never applied), so the
// catalogue is empty. Sales need a product with stock behind it.
let productId = '';

async function post(path: string, body: unknown) {
  return SELF.fetch(`https://api.test${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify(body),
  });
}

function patch(path: string, body: unknown) {
  return SELF.fetch(`https://api.test${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(body),
  });
}

function del(path: string) {
  return SELF.fetch(`https://api.test${path}`, { method: 'DELETE', headers: { Cookie: cookie } });
}

function get(path: string) {
  return SELF.fetch(`https://api.test${path}`, { headers: { Cookie: cookie } });
}

async function newCustomer(name: string, phone?: string) {
  const res = await post('/api/customers', { name, phone });
  expect(res.status).toBe(201);
  return (await res.json<{ id: string }>()).id;
}

/** A cash sale for an existing customer, which leaves an invoice and ledger rows. */
async function sellTo(customerId: string) {
  const res = await post('/api/sales', {
    customerId,
    lines: [{ productId, qty: 1, rate: 100 }],
    paidCash: 100,
    cashAccountId: 'ca_counter',
  });
  expect(res.status).toBe(201);
}

beforeAll(async () => {
  await DB.prepare(`DELETE FROM users WHERE username = 'custuser'`).run();
  await createUser(DB, { name: 'Customer Tester', username: 'custuser', password: 'customers-pass-1' });

  const res = await SELF.fetch('https://api.test/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'custuser', password: 'customers-pass-1' }),
  });
  cookie = res.headers.get('Set-Cookie')!.split(';')[0];

  const company = await post('/api/catalog/companies', { name: 'Delete Test Supplier' });
  const companyId = (await company.json<{ id: string }>()).id;
  const product = await post('/api/catalog/products', {
    name: 'Delete Test Product',
    companyId,
    category: 'other',
    purchaseRate: 100,
    saleRate: 150,
  });
  productId = (await product.json<{ id: string }>()).id;

  // Stock, so the sale guard is not what the test ends up measuring.
  const purchase = await post('/api/purchases', {
    companyId,
    lines: [{ productId, qty: 500, rate: 100 }],
    paidCash: 0,
    cashAccountId: 'ca_counter',
  });
  expect(purchase.status).toBe(201);
});

describe('deleting a customer', () => {
  it('deletes a customer added by mistake, before anything refers to them', async () => {
    const id = await newCustomer('Typo Perrson');

    const usage = await (await get(`/api/customers/${id}/usage`)).json<{
      usage: { canDelete: boolean; blockedBy: string | null };
    }>();
    expect(usage.usage.canDelete).toBe(true);
    expect(usage.usage.blockedBy).toBeNull();

    const res = await del(`/api/customers/${id}`);
    expect(res.status).toBe(200);

    const gone = await DB.prepare(`SELECT id FROM customers WHERE id = ?`).bind(id).first();
    expect(gone).toBeNull();
  });

  it('deletes a duplicate entry and keeps the original intact', async () => {
    // The case the shop actually hits: a name entered twice. Both are untouched,
    // so either can go -- and the survivor must keep its phone number, which is
    // unique in the table.
    const original = await newCustomer('Allah Ditta', '03001112222');
    const duplicate = await newCustomer('Allah Ditta');

    expect((await del(`/api/customers/${duplicate}`)).status).toBe(200);

    const survivor = await DB.prepare(`SELECT name, phone FROM customers WHERE id = ?`)
      .bind(original)
      .first<{ name: string; phone: string }>();
    expect(survivor!.name).toBe('Allah Ditta');
    expect(survivor!.phone).toBe('03001112222');
  });

  it('refuses to delete a customer who still owes money, and says how much', async () => {
    const id = await newCustomer('Owes Money');

    // A credit sale: an invoice and a customer ledger row, no cash.
    const sale = await post('/api/sales', {
      customerId: id,
      lines: [{ productId, qty: 5, rate: 100 }],
      paidCash: 0,
      cashAccountId: 'ca_counter',
    });
    expect(sale.status).toBe(201);

    const usage = await (await get(`/api/customers/${id}/usage`)).json<{
      usage: { canDelete: boolean; blockedBy: string; balancePaisa: number };
    }>();
    expect(usage.usage.balancePaisa).toBe(50000);
    expect(usage.usage.blockedBy).toMatch(/still owe/i);
    expect(usage.usage.blockedBy).toMatch(/Rs 500\.00/); // rupees, not paisa

    const res = await del(`/api/customers/${id}`);
    expect(res.status).toBe(409);
    const body = await res.json<{ code: string; error: string }>();
    expect(body.code).toBe('customer_in_use');
    expect(body.error).toMatch(/Deactivate/i);

    // Still there.
    const still = await DB.prepare(`SELECT id FROM customers WHERE id = ?`).bind(id).first();
    expect(still).not.toBeNull();
  });

  it('refuses a settled customer that has sales history', async () => {
    // Zero balance is not a safe test -- exactly the trap the company delete had.
    const id = await newCustomer('Paid Up');
    await sellTo(id);

    const usage = await (await get(`/api/customers/${id}/usage`)).json<{
      usage: { canDelete: boolean; blockedBy: string; balancePaisa: number; invoices: number };
    }>();
    expect(usage.usage.balancePaisa).toBe(0);
    expect(usage.usage.invoices).toBe(1);
    expect(usage.usage.canDelete).toBe(false);
    expect(usage.usage.blockedBy).toMatch(/invoice/i);

    expect((await del(`/api/customers/${id}`)).status).toBe(409);
  });

  it('never deletes the walk-in cash customer billing depends on', async () => {
    const usage = await (await get(`/api/customers/cust_walkin/usage`)).json<{
      usage: { canDelete: boolean; canDeactivate: boolean; blockedBy: string };
    }>();
    expect(usage.usage.canDelete).toBe(false);
    expect(usage.usage.canDeactivate).toBe(false);
    expect(usage.usage.blockedBy).toMatch(/walk-in/i);

    expect((await del(`/api/customers/cust_walkin`)).status).toBe(409);
    const still = await DB.prepare(`SELECT id FROM customers WHERE id = 'cust_walkin'`).first();
    expect(still).not.toBeNull();
  });

  it('404s an unknown customer', async () => {
    expect((await del('/api/customers/cust_does_not_exist')).status).toBe(404);
    expect((await get('/api/customers/cust_does_not_exist/usage')).status).toBe(404);
  });

  it('deactivates instead, hiding them from billing but not from the management list', async () => {
    const id = await newCustomer('Hide Me', '03009998888');
    await sellTo(id);

    expect((await patch(`/api/customers/${id}`, { isActive: false })).status).toBe(200);

    const trading = await (await get('/api/customers?limit=100')).json<{
      customers: { id: string }[];
    }>();
    expect(trading.customers.some((c) => c.id === id)).toBe(false);

    const management = await (await get('/api/customers?limit=100&all=1')).json<{
      customers: { id: string; is_active: number }[];
    }>();
    const row = management.customers.find((c) => c.id === id);
    expect(row).toBeDefined();
    expect(row!.is_active).toBe(0);

    // And back again -- otherwise hiding someone is a one-way door.
    expect((await patch(`/api/customers/${id}`, { isActive: true })).status).toBe(200);
    const back = await (await get('/api/customers?limit=100')).json<{ customers: { id: string }[] }>();
    expect(back.customers.some((c) => c.id === id)).toBe(true);
  });
});
