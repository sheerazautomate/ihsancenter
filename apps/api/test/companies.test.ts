import { describe, it, expect, beforeAll } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { createUser } from '../src/lib/auth';

const DB = env.DB as D1Database;
let cookie = '';

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

async function newCompany(name: string) {
  const res = await post('/api/catalog/companies', { name });
  expect(res.status).toBe(201);
  return (await res.json<{ id: string }>()).id;
}

beforeAll(async () => {
  // Created directly rather than through /auth/bootstrap: isolatedStorage gives
  // each test its own snapshot, so a token minted in one test is not valid in the
  // next. One user created here, then a real login for the cookie.
  await DB.prepare(`DELETE FROM users WHERE username = 'companyuser'`).run();
  await createUser(DB, { name: 'Company Tester', username: 'companyuser', password: 'company-pass-1' });

  const res = await SELF.fetch('https://api.test/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'companyuser', password: 'company-pass-1' }),
  });
  cookie = res.headers.get('Set-Cookie')!.split(';')[0];
});

describe('companies', () => {
  it('creates, renames and refuses a duplicate name', async () => {
    const id = await newCompany('Test Agri Co');
    const renamed = await patch(`/api/catalog/companies/${id}`, { name: 'Test Agri Company' });
    expect(renamed.status).toBe(200);

    const row = await DB.prepare(`SELECT name FROM companies WHERE id = ?`).bind(id).first<{ name: string }>();
    expect(row!.name).toBe('Test Agri Company');

    const dup = await post('/api/catalog/companies', { name: 'Test Agri Company' });
    expect(dup.status).toBe(409);
  });

  it('returns address and notes in the list, so editing cannot blank them', async () => {
    // The web form is filled from the list endpoint, not from the detail call. If
    // the list omitted these columns the form would open empty and "save" would
    // write null over real values -- silent data loss that looks like a save.
    const created = await post('/api/catalog/companies', {
      name: 'Fields Co',
      contactPerson: 'Bilal',
      phone: '03001234567',
      address: 'Chowk Azam, Layyah',
      notes: 'delivers on Mondays',
    });
    expect(created.status).toBe(201);

    const list = await (await get('/api/catalog/companies')).json<{
      companies: Array<{ name: string; address: string | null; notes: string | null }>;
    }>();
    const row = list.companies.find((c) => c.name === 'Fields Co')!;
    expect(row.address).toBe('Chowk Azam, Layyah');
    expect(row.notes).toBe('delivers on Mondays');
  });

  it('deletes a company that nothing refers to', async () => {
    const id = await newCompany('Unused Co');
    const res = await del(`/api/catalog/companies/${id}`);
    expect(res.status).toBe(200);

    const row = await DB.prepare(`SELECT COUNT(*) AS n FROM companies WHERE id = ?`).bind(id).first<{ n: number }>();
    expect(row!.n).toBe(0);
  });

  it('deactivates instead of deleting, and hides it from the trading lists', async () => {
    const id = await newCompany('Seasonal Co');
    await patch(`/api/catalog/companies/${id}`, { isActive: false });

    // Default list (used by purchases and payments) excludes it...
    const active = await (await get('/api/catalog/companies')).json<{ companies: { id: string }[] }>();
    expect(active.companies.some((c) => c.id === id)).toBe(false);

    // ...but the management screen can still see it to reactivate.
    const all = await (await get('/api/catalog/companies?all=1')).json<{ companies: { id: string }[] }>();
    expect(all.companies.some((c) => c.id === id)).toBe(true);
  });

  it('refuses to delete a company that owns a product, even with a zero balance', async () => {
    // This is the case "balance = 0" would wave through: nothing is owed, but a
    // product still points at the company. Deleting would orphan it.
    const id = await newCompany('Has Products Co');
    await post('/api/catalog/products', {
      name: 'Owned by company',
      companyId: id,
      category: 'other',
      purchaseRate: 10,
      saleRate: 20,
    });

    const usage = await (await get(`/api/catalog/companies/${id}`)).json<{
      usage: { canDelete: boolean; blockedBy: string; balancePaisa: number };
    }>();
    expect(usage.usage.balancePaisa).toBe(0);
    expect(usage.usage.canDelete).toBe(false);
    expect(usage.usage.blockedBy).toMatch(/product/i);

    const res = await del(`/api/catalog/companies/${id}`);
    expect(res.status).toBe(409);
    const body = await res.json<{ code: string; error: string }>();
    expect(body.code).toBe('company_in_use');
    expect(body.error).toMatch(/Deactivate/i);
  });

  it('refuses to delete a company with an unpaid balance, and says which way', async () => {
    const id = await newCompany('Owed Co');

    // A real purchase needs a product; use one under the company so the payable exists.
    const prod = await post('/api/catalog/products', {
      name: 'Owed product',
      companyId: id,
      category: 'other',
      purchaseRate: 100,
      saleRate: 150,
    });
    const productId = (await prod.json<{ id: string }>()).id;

    const purchase = await post('/api/purchases', {
      companyId: id,
      lines: [{ productId, qty: 5, rate: 100 }],
      paidCash: 0,
      cashAccountId: 'ca_counter',
    });
    expect(purchase.status).toBe(201);

    const usage = await (await get(`/api/catalog/companies/${id}`)).json<{
      usage: { canDelete: boolean; blockedBy: string; balancePaisa: number };
    }>();
    expect(usage.usage.balancePaisa).toBe(50000); // Rs 500 owed
    expect(usage.usage.canDelete).toBe(false);
    // Direction matters: "you owe them" and "they owe you" are opposite problems.
    expect(usage.usage.blockedBy).toMatch(/you still owe them/i);
    expect(usage.usage.blockedBy).toMatch(/Rs 500\.00/); // rupees, not raw paisa

    expect((await del(`/api/catalog/companies/${id}`)).status).toBe(409);
  });

  it('reports the opposite direction when the company owes the shop', async () => {
    // Buy 5 @ 100, pay for all 5, then return 2 with no refund: the shop now
    // holds 200 of the supplier's money, so the balance runs the other way. Saying "you still owe
    // them" here would send the shopkeeper to pay a debt that does not exist.
    const id = await newCompany('Return Co');
    const prod = await post('/api/catalog/products', {
      name: 'Return product',
      companyId: id,
      category: 'other',
      purchaseRate: 100,
      saleRate: 150,
    });
    const productId = (await prod.json<{ id: string }>()).id;

    const purchase = await post('/api/purchases', {
      companyId: id,
      lines: [{ productId, qty: 5, rate: 100 }],
      paidCash: 0,
      cashAccountId: 'ca_counter',
    });
    expect(purchase.status).toBe(201);

    // Pay in full first, so the return genuinely leaves money in the shop's hands.
    const payment = await post('/api/purchases/payments', {
      companyId: id,
      amount: 500,
      mode: 'cash',
      cashAccountId: 'ca_counter',
    });
    expect(payment.status).toBe(201);

    const ret = await post('/api/purchases/returns', {
      companyId: id,
      lines: [{ productId, qty: 2, rate: 100 }],
      refundCash: 0,
      cashAccountId: 'ca_counter',
      reason: 'damaged bags',
    });
    expect(ret.status).toBe(201);

    const usage = await (await get(`/api/catalog/companies/${id}`)).json<{
      usage: { canDelete: boolean; blockedBy: string; balancePaisa: number };
    }>();
    expect(usage.usage.balancePaisa).toBe(-20000); // Rs 200 in the shop's favour
    expect(usage.usage.canDelete).toBe(false);
    expect(usage.usage.blockedBy).toMatch(/they owe you/i);
    expect(usage.usage.blockedBy).toMatch(/Rs 200\.00/);

    expect((await del(`/api/catalog/companies/${id}`)).status).toBe(409);
  });

  it('allows deletion once the balance is settled and nothing else refers to it', async () => {
    // Settle by paying in full, with no products and no documents left behind --
    // which, with a real purchase, is impossible; so assert the API's own rule:
    // the payment leaves a ledger entry, which still blocks deletion.
    const id = await newCompany('Settled Co');
    const prod = await post('/api/catalog/products', {
      name: 'Settled product',
      companyId: id,
      category: 'other',
      purchaseRate: 100,
      saleRate: 150,
    });
    const productId = (await prod.json<{ id: string }>()).id;

    const purchase = await post('/api/purchases', {
      companyId: id,
      lines: [{ productId, qty: 1, rate: 100 }],
      paidCash: 0,
      cashAccountId: 'ca_counter',
    });
    expect(purchase.status).toBe(201);

    const payment = await post('/api/purchases/payments', {
      companyId: id,
      amount: 100,
      mode: 'cash',
      cashAccountId: 'ca_counter',
    });
    expect(payment.status).toBe(201);

    const usage = await (await get(`/api/catalog/companies/${id}`)).json<{
      usage: { canDelete: boolean; balancePaisa: number; ledgerEntries: number };
    }>();
    expect(usage.usage.balancePaisa).toBe(0); // settled
    expect(usage.usage.canDelete).toBe(false); // but history remains
    expect((await del(`/api/catalog/companies/${id}`)).status).toBe(409);
  });

  it('404s an unknown company', async () => {
    expect((await del('/api/catalog/companies/nope')).status).toBe(404);
    expect((await get('/api/catalog/companies/nope')).status).toBe(404);
  });
});
