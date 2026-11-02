import { describe, it, expect, beforeAll } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { createUser } from '../src/lib/auth';

const DB = env.DB as D1Database;
let cookie = '';
let productId = '';

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

async function newCustomer(name: string) {
  const res = await post('/api/customers', { name });
  expect(res.status).toBe(201);
  return (await res.json<{ id: string }>()).id;
}

/** Credit sale of `qty` units at `rate`, returning the invoice id. */
async function creditSale(customerId: string, qty: number, rate: number) {
  const res = await post('/api/sales', {
    customerId,
    lines: [{ productId, qty, rate }],
    paidCash: 0,
    cashAccountId: 'ca_counter',
  });
  expect(res.status).toBe(201);
  const body = await res.json<{ sale: { id: string; invoiceNo: string } }>();
  return body.sale;
}

interface UnpaidInvoice {
  id: string;
  invoice_no: string;
  bal: number;
}

beforeAll(async () => {
  await DB.prepare(`DELETE FROM users WHERE username = 'allocuser'`).run();
  await createUser(DB, { name: 'Allocation Tester', username: 'allocuser', password: 'alloc-pass-1' });

  const res = await SELF.fetch('https://api.test/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'allocuser', password: 'alloc-pass-1' }),
  });
  cookie = res.headers.get('Set-Cookie')!.split(';')[0];

  const company = await post('/api/catalog/companies', { name: 'Allocation Supplier' });
  const companyId = (await company.json<{ id: string }>()).id;
  const product = await post('/api/catalog/products', {
    name: 'Allocation Product',
    companyId,
    category: 'other',
    purchaseRate: 100,
    saleRate: 150,
  });
  productId = (await product.json<{ id: string }>()).id;

  const purchase = await post('/api/purchases', {
    companyId,
    lines: [{ productId, qty: 1000, rate: 100 }],
    paidCash: 0,
    cashAccountId: 'ca_counter',
  });
  expect(purchase.status).toBe(201);
});

describe('collecting against a chosen invoice', () => {
  it('allocates the receipt to the invoice the customer picked, not the oldest', async () => {
    const customerId = await newCustomer('Picks A Bill');
    const first = await creditSale(customerId, 5, 100); // Rs 500, oldest
    const second = await creditSale(customerId, 10, 100); // Rs 1000, newer

    const unpaid = await (await get(`/api/sales/unpaid/${customerId}`)).json<{
      invoices: UnpaidInvoice[];
    }>();
    const target = unpaid.invoices.find((i) => i.id === second.id)!;
    expect(target.bal).toBe(100000);

    // Clear the NEWER bill. Oldest-first would have taken the first one.
    const receipt = await post('/api/money/receipts', {
      customerId,
      amount: 1000,
      mode: 'cash',
      cashAccountId: 'ca_counter',
      allocations: [{ invoiceId: second.id, amount: 1000 }],
    });
    expect(receipt.status).toBe(201);
    expect((await receipt.json<{ receipt: { unallocatedPaisa: number } }>()).receipt.unallocatedPaisa).toBe(0);

    const after = await (await get(`/api/sales/unpaid/${customerId}`)).json<{
      invoices: UnpaidInvoice[];
    }>();
    // The newer invoice is gone from unpaid; the older one is untouched.
    expect(after.invoices.some((i) => i.id === second.id)).toBe(false);
    expect(after.invoices.find((i) => i.id === first.id)?.bal).toBe(50000);
  });

  it('shows the part payment against that invoice, and the invoice still listed', async () => {
    const customerId = await newCustomer('Part Payer');
    const invoice = await creditSale(customerId, 10, 100); // Rs 1000

    await post('/api/money/receipts', {
      customerId,
      amount: 400,
      mode: 'bank',
      cashAccountId: 'ca_bank',
      allocations: [{ invoiceId: invoice.id, amount: 400 }],
    });

    const detail = await (await get(`/api/sales/${invoice.id}`)).json<{
      payment: { settledPaisa: number; outstandingPaisa: number; receipts: unknown[] };
    }>();
    expect(detail.payment.settledPaisa).toBe(40000);
    expect(detail.payment.outstandingPaisa).toBe(60000);

    // And the list agrees, rather than repeating the original credit.
    const today = new Date().toISOString().slice(0, 10);
    const list = await (await get(`/api/sales?from=${today}&to=${today}&limit=200`)).json<{
      invoices: { id: string; outstanding_paisa: number; pay_state: string; credit_paisa: number }[];
    }>();
    const row = list.invoices.find((i) => i.id === invoice.id)!;
    expect(row.credit_paisa).toBe(100000); // what was billed
    expect(row.outstanding_paisa).toBe(60000); // what is still owed
    expect(row.pay_state).toBe('part');
  });

  it('marks a fully cleared invoice as settled, with nothing outstanding', async () => {
    const customerId = await newCustomer('Clears Fully');
    const invoice = await creditSale(customerId, 4, 250); // Rs 1000

    await post('/api/money/receipts', {
      customerId,
      amount: 1000,
      mode: 'cash',
      cashAccountId: 'ca_counter',
      allocations: [{ invoiceId: invoice.id, amount: 1000 }],
    });

    const detail = await (await get(`/api/sales/${invoice.id}`)).json<{
      payment: { settledPaisa: number; outstandingPaisa: number; receipts: { amount_paisa: number }[] };
    }>();
    expect(detail.payment.settledPaisa).toBe(100000);
    expect(detail.payment.outstandingPaisa).toBe(0);
    expect(detail.payment.receipts).toHaveLength(1);
  });

  it('refuses an allocation larger than the bill still owes', async () => {
    const customerId = await newCustomer('Over Allocates');
    const invoice = await creditSale(customerId, 2, 100); // Rs 200

    const res = await post('/api/money/receipts', {
      customerId,
      amount: 500,
      mode: 'cash',
      cashAccountId: 'ca_counter',
      allocations: [{ invoiceId: invoice.id, amount: 500 }],
    });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toMatch(/exceeds its balance/i);
  });

  it('refuses to allocate to another customer\'s invoice', async () => {
    const owner = await newCustomer('Real Owner');
    const invoice = await creditSale(owner, 5, 100);
    const stranger = await newCustomer('Pays Someone Else');

    const res = await post('/api/money/receipts', {
      customerId: stranger,
      amount: 500,
      mode: 'cash',
      cashAccountId: 'ca_counter',
      allocations: [{ invoiceId: invoice.id, amount: 500 }],
    });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toMatch(/not open for this customer/i);
  });

  it('keeps the excess as an advance instead of silently clearing another bill', async () => {
    // The customer says "clear this one" and hands over more than it owes. The
    // screen sends only what that bill needs; the rest must land as an advance,
    // not quietly pay down a different invoice the customer did not mention.
    const customerId = await newCustomer('Pays Extra');
    const target = await creditSale(customerId, 2, 100); // Rs 200
    const other = await creditSale(customerId, 10, 100); // Rs 1000

    const receipt = await post('/api/money/receipts', {
      customerId,
      amount: 500,
      mode: 'cash',
      cashAccountId: 'ca_counter',
      allocations: [{ invoiceId: target.id, amount: 200 }],
    });
    expect(receipt.status).toBe(201);
    const body = await receipt.json<{ receipt: { unallocatedPaisa: number } }>();
    expect(body.receipt.unallocatedPaisa).toBe(30000); // Rs 300 held

    const unpaid = await (await get(`/api/sales/unpaid/${customerId}`)).json<{
      invoices: UnpaidInvoice[];
    }>();
    expect(unpaid.invoices.some((i) => i.id === target.id)).toBe(false);
    expect(unpaid.invoices.find((i) => i.id === other.id)?.bal).toBe(100000);
  });
});
