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

function get(path: string) {
  return SELF.fetch(`https://api.test${path}`, { headers: { Cookie: cookie } });
}

/** A company with one product and a credit purchase of `qty * rate`. */
async function creditPurchase(name: string, qty: number, rate: number) {
  const company = await post('/api/catalog/companies', { name });
  expect(company.status).toBe(201);
  const companyId = (await company.json<{ id: string }>()).id;

  const prod = await post('/api/catalog/products', {
    name: `${name} product`,
    companyId,
    category: 'other',
    purchaseRate: rate,
    saleRate: rate * 1.5,
  });
  expect(prod.status).toBe(201);
  const productId = (await prod.json<{ id: string }>()).id;

  const purchase = await post('/api/purchases', {
    companyId,
    lines: [{ productId, qty, rate }],
    paidCash: 0,
    cashAccountId: 'ca_counter',
  });
  expect(purchase.status).toBe(201);

  return { companyId, productId };
}

beforeAll(async () => {
  await DB.prepare(`DELETE FROM users WHERE username = 'payuser'`).run();
  await createUser(DB, { name: 'Payables Tester', username: 'payuser', password: 'payables-pass-1' });

  const res = await SELF.fetch('https://api.test/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'payuser', password: 'payables-pass-1' }),
  });
  cookie = res.headers.get('Set-Cookie')!.split(';')[0];
});

describe('supplier payments', () => {
  it('lists the company as payable after a credit purchase, and clears it when paid', async () => {
    const { companyId } = await creditPurchase('Pay Co', 5, 100);

    const before = await (await get('/api/reports/payables')).json<{
      companies: { companyId: string; totalPaisa: number }[];
    }>();
    expect(before.companies.find((c) => c.companyId === companyId)?.totalPaisa).toBe(50000);

    const paid = await post('/api/purchases/payments', {
      companyId,
      amount: 500,
      mode: 'cash',
      cashAccountId: 'ca_counter',
    });
    expect(paid.status).toBe(201);
    expect((await paid.json<{ paymentNo: string }>()).paymentNo).toMatch(/^PAY-/);

    const after = await (await get('/api/reports/payables')).json<{
      companies: { companyId: string; totalPaisa: number }[];
    }>();
    // Settled to zero, so it drops out of the report entirely.
    expect(after.companies.find((c) => c.companyId === companyId)).toBeUndefined();
  });

  it('allows a part payment and leaves the rest payable', async () => {
    const { companyId } = await creditPurchase('Part Co', 10, 100); // Rs 1000

    const paid = await post('/api/purchases/payments', {
      companyId,
      amount: 400,
      mode: 'bank',
      cashAccountId: 'ca_bank',
    });
    expect(paid.status).toBe(201);

    const report = await (await get('/api/reports/payables')).json<{
      companies: { companyId: string; totalPaisa: number }[];
    }>();
    expect(report.companies.find((c) => c.companyId === companyId)?.totalPaisa).toBe(60000);
  });

  it('refuses to pay more than is owed, and names the real balance', async () => {
    // Without this guard the supplier ledger flips negative: the shop would look
    // like it is holding the company's money, with nothing recorded to explain it.
    const { companyId } = await creditPurchase('Overpay Co', 2, 100); // Rs 200

    const tooMuch = await post('/api/purchases/payments', {
      companyId,
      amount: 500,
      mode: 'cash',
      cashAccountId: 'ca_counter',
    });
    expect(tooMuch.status).toBe(400);
    const body = await tooMuch.json<{ error: string }>();
    expect(body.error).toMatch(/Rs 200\.00/);
    expect(body.error).toMatch(/more than that/i);

    // And nothing was written: the payable is untouched.
    const report = await (await get('/api/reports/payables')).json<{
      companies: { companyId: string; totalPaisa: number }[];
    }>();
    expect(report.companies.find((c) => c.companyId === companyId)?.totalPaisa).toBe(20000);
  });

  it('refuses payment to a company that is owed nothing', async () => {
    const company = await post('/api/catalog/companies', { name: 'Nothing Owed Co' });
    const companyId = (await company.json<{ id: string }>()).id;

    const res = await post('/api/purchases/payments', {
      companyId,
      amount: 100,
      mode: 'cash',
      cashAccountId: 'ca_counter',
    });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toMatch(/Nothing is owed/i);
  });

  it('lists unpaid bills with their item counts, and the payments made', async () => {
    const { companyId } = await creditPurchase('Bills Co', 5, 100);

    const unpaid = await (await get(`/api/purchases/unpaid/${companyId}`)).json<{
      purchases: { purchase_no: string; payable_paisa: number; line_count: number }[];
    }>();
    expect(unpaid.purchases).toHaveLength(1);
    expect(unpaid.purchases[0].payable_paisa).toBe(50000);
    expect(unpaid.purchases[0].line_count).toBe(1);
    expect(unpaid.purchases[0].purchase_no).toMatch(/^PUR-/);

    await post('/api/purchases/payments', {
      companyId,
      amount: 200,
      mode: 'cash',
      cashAccountId: 'ca_counter',
    });

    const history = await (await get(`/api/purchases/payments/${companyId}`)).json<{
      payments: { payment_no: string; amount_paisa: number; mode: string }[];
    }>();
    expect(history.payments).toHaveLength(1);
    expect(history.payments[0].amount_paisa).toBe(20000);
    expect(history.payments[0].mode).toBe('cash');
  });

  it('clears the company delete block once the payable is settled', async () => {
    // The point of the whole screen: a company paid in full no longer trips the
    // balance check. It may still own a product, and that is reported separately.
    const { companyId } = await creditPurchase('Settle Co', 5, 100);

    const blocked = await (await get(`/api/catalog/companies/${companyId}`)).json<{
      usage: { blockedBy: string; balancePaisa: number };
    }>();
    expect(blocked.usage.balancePaisa).toBe(50000);
    expect(blocked.usage.blockedBy).toMatch(/you still owe them/i);

    await post('/api/purchases/payments', {
      companyId,
      amount: 500,
      mode: 'cash',
      cashAccountId: 'ca_counter',
    });

    const settled = await (await get(`/api/catalog/companies/${companyId}`)).json<{
      usage: { blockedBy: string; balancePaisa: number };
    }>();
    expect(settled.usage.balancePaisa).toBe(0);
    expect(settled.usage.blockedBy).toMatch(/product/i);
  });

  it('does not post the same payment twice when the key repeats', async () => {
    const { companyId } = await creditPurchase('Retry Co', 10, 100);
    const key = crypto.randomUUID();
    const body = JSON.stringify({
      companyId,
      amount: 100,
      mode: 'cash',
      cashAccountId: 'ca_counter',
    });
    const send = () =>
      SELF.fetch('https://api.test/api/purchases/payments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie, 'Idempotency-Key': key },
        body,
      });

    expect((await send()).status).toBe(201);

    // The retry must look like success, not a 500: the first payment is already on
    // the books, and the manager's screen should not show an error for it.
    const replay = await send();
    expect(replay.status).toBe(200);
    expect((await replay.json<{ paymentNo: string }>()).paymentNo).toMatch(/^PAY-/);

    const report = await (await get('/api/reports/payables')).json<{
      companies: { companyId: string; totalPaisa: number }[];
    }>();
    // 1000 owed, one 100 payment applied -- a double post would read 800.
    expect(report.companies.find((c) => c.companyId === companyId)?.totalPaisa).toBe(90000);
  });
});
