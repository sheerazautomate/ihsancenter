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

/** Credit sale: `qty` units at `rate`. */
async function creditSale(customerId: string, qty: number, rate: number) {
  const res = await post('/api/sales', {
    customerId,
    lines: [{ productId, qty, rate }],
    paidCash: 0,
    cashAccountId: 'ca_counter',
  });
  expect(res.status).toBe(201);
  return (await res.json<{ sale: { id: string; invoiceNo: string } }>()).sale;
}

async function stockOf(id: string): Promise<number> {
  const row = await DB.prepare(`SELECT qty_on_hand_milli FROM products WHERE id = ?`)
    .bind(id)
    .first<{ qty_on_hand_milli: number }>();
  return row!.qty_on_hand_milli;
}

async function owedBy(customerId: string): Promise<number> {
  const row = await DB.prepare(
    `SELECT COALESCE(SUM(debit_paisa - credit_paisa), 0) AS owed FROM ledger_entries
     WHERE account_type = 'customer' AND account_id = ?`,
  )
    .bind(customerId)
    .first<{ owed: number }>();
  return row!.owed;
}

beforeAll(async () => {
  await DB.prepare(`DELETE FROM users WHERE username = 'sretuser'`).run();
  await createUser(DB, { name: 'Return Tester', username: 'sretuser', password: 'sret-pass-1' });

  const res = await SELF.fetch('https://api.test/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'sretuser', password: 'sret-pass-1' }),
  });
  cookie = res.headers.get('Set-Cookie')!.split(';')[0];

  const company = await post('/api/catalog/companies', { name: 'Return Supplier' });
  const companyId = (await company.json<{ id: string }>()).id;
  const product = await post('/api/catalog/products', {
    name: 'Return Product',
    companyId,
    category: 'other',
    purchaseRate: 100,
    saleRate: 200,
  });
  productId = (await product.json<{ id: string }>()).id;

  const purchase = await post('/api/purchases', {
    companyId,
    lines: [{ productId, qty: 500, rate: 100 }],
    paidCash: 0,
    cashAccountId: 'ca_counter',
  });
  expect(purchase.status).toBe(201);
});

describe('what can still be returned', () => {
  it('reports the returnable quantity per line and what the customer owes', async () => {
    const customerId = await newCustomer('Returnable Rao');
    const invoice = await creditSale(customerId, 10, 200);

    const body = await (await get(`/api/sales/${invoice.id}/returnable`)).json<{
      canReturn: boolean;
      owedByCustomerPaisa: number;
      lines: { qty_milli: number; returnable_milli: number; product_name: string }[];
    }>();

    expect(body.canReturn).toBe(true);
    expect(body.owedByCustomerPaisa).toBe(200000); // Rs 2000
    expect(body.lines).toHaveLength(1);
    expect(body.lines[0].qty_milli).toBe(10000);
    expect(body.lines[0].returnable_milli).toBe(10000);
  });

  it('404s an invoice that does not exist', async () => {
    expect((await get('/api/sales/inv_nope/returnable')).status).toBe(404);
  });
});

describe('returning goods', () => {
  it('puts stock back, credits the customer, and shrinks their udhaar', async () => {
    const customerId = await newCustomer('Returns Part');
    const invoice = await creditSale(customerId, 10, 200); // Rs 2000 on credit

    const before = await stockOf(productId);
    const owedBefore = await owedBy(customerId);
    expect(owedBefore).toBe(200000);

    // Two units back, all as a credit note because he still owes.
    const res = await post('/api/sales/returns', {
      customerId,
      invoiceId: invoice.id,
      lines: [{ productId, qty: 2, rate: 200 }],
      creditNote: 400,
      reason: 'unused, brought back the next day',
    });
    expect(res.status).toBe(201);
    const body = await res.json<{ returnNo: string; creditNotePaisa: number; totalPaisa: number }>();
    expect(body.returnNo).toMatch(/^SR-/);
    expect(body.totalPaisa).toBe(40000);
    expect(body.creditNotePaisa).toBe(40000);

    expect(await stockOf(productId)).toBe(before + 2000); // 2 units back
    expect(await owedBy(customerId)).toBe(160000); // Rs 2000 - Rs 400
  });

  it('refunds cash when the customer owes nothing', async () => {
    const customerId = await newCustomer('Paid Then Returned');
    const product = await DB.prepare(`SELECT sale_rate_paisa FROM products WHERE id = ?`)
      .bind(productId)
      .first<{ sale_rate_paisa: number }>();
    expect(product).not.toBeNull();

    // A cash sale: nothing owed afterwards.
    const sale = await post('/api/sales', {
      customerId,
      lines: [{ productId, qty: 3, rate: 200 }],
      paidCash: 600,
      cashAccountId: 'ca_counter',
    });
    expect(sale.status).toBe(201);
    const invoiceId = (await sale.json<{ sale: { id: string } }>()).sale.id;
    expect(await owedBy(customerId)).toBe(0);

    const cashBefore = await DB.prepare(
      `SELECT COALESCE(SUM(debit_paisa - credit_paisa), 0) AS bal FROM ledger_entries
       WHERE account_type = 'cash' AND account_id = 'ca_counter'`,
    ).first<{ bal: number }>();

    const res = await post('/api/sales/returns', {
      customerId,
      invoiceId,
      lines: [{ productId, qty: 1, rate: 200 }],
      refundCash: 200,
      cashAccountId: 'ca_counter',
      reason: 'wrong product',
    });
    expect(res.status).toBe(201);

    // A cash sale never debited the customer, so a cash refund leaves his account
    // untouched -- the money comes out of the till instead. Crediting him as well
    // would invent a balance that was never there.
    expect(await owedBy(customerId)).toBe(0);

    const cashAfter = await DB.prepare(
      `SELECT COALESCE(SUM(debit_paisa - credit_paisa), 0) AS bal FROM ledger_entries
       WHERE account_type = 'cash' AND account_id = 'ca_counter'`,
    ).first<{ bal: number }>();
    expect(cashAfter!.bal).toBe(cashBefore!.bal - 20000); // Rs 200 left the till

    // And the revenue it had recognised is reversed.
    const reversed = await DB.prepare(
      `SELECT COALESCE(SUM(debit_paisa), 0) AS dr FROM ledger_entries
       WHERE account_type = 'sale_return' AND doc_id = (
         SELECT id FROM sale_returns WHERE customer_id = ? ORDER BY created_at DESC LIMIT 1)`,
    ).bind(customerId).first<{ dr: number }>();
    expect(reversed!.dr).toBe(20000);
  });

  it('refuses a return that names no invoice', async () => {
    // Found by driving the real API, not by the suite: with invoiceId optional, a
    // return skipped the per-line cap entirely and 9 bags came back off a line
    // that had already had 3 returned. Without a bill there is nothing to cap
    // against, so the request is refused instead of quietly trusted.
    const customerId = await newCustomer('No Slip');
    const res = await post('/api/sales/returns', {
      customerId,
      lines: [{ productId, qty: 1, rate: 200 }],
      creditNote: 200,
      reason: 'lost the slip',
    });
    expect(res.status).toBe(400);
    expect(await res.json<{ error: string }>()).toMatchObject({ error: 'Invalid sale return' });
  });

  it('shows a cash refund on the bill, even though it moves no balance', async () => {
    // The farmer handed money back over the counter. If the invoice history only
    // lists what reduced his udhaar, a refunded bill prints as untouched -- and
    // the one document meant to settle the argument says nothing happened.
    const customerId = await newCustomer('Refund Slip');
    const sale = await post('/api/sales', {
      customerId,
      lines: [{ productId, qty: 2, rate: 200 }],
      paidCash: 400,
      cashAccountId: 'ca_counter',
    });
    const invoiceId = (await sale.json<{ sale: { id: string } }>()).sale.id;

    const ret = await post('/api/sales/returns', {
      customerId,
      invoiceId,
      docDate: '2026-07-04',
      lines: [{ productId, qty: 1, rate: 200 }],
      refundCash: 200,
      cashAccountId: 'ca_counter',
      reason: 'damaged bag',
    });
    expect(ret.status).toBe(201);
    const returnNo = (await ret.json<{ returnNo: string }>()).returnNo;

    const detail = await get(`/api/sales/${invoiceId}`);
    const body = await detail.json<{
      payment: {
        history: { document: string; kind: string; mode: string; amountPaisa: number; refundPaisa?: number }[];
      };
    }>();
    const row = body.payment.history.find((h) => h.document === returnNo);
    expect(row).toBeDefined();
    expect(row!.amountPaisa).toBe(0); // nothing was credited to his account
    expect(row!.refundPaisa).toBe(20000); // but Rs 200 did change hands
    expect(row!.mode).toBe('cash refund'); // and the slip says so in those words
  });

  it('replays the stored return, not the amounts this attempt asked for', async () => {
    // Same key, different numbers: the stored document is what the books hold,
    // so the reply must describe it rather than echo the retried request.
    const customerId = await newCustomer('Replay Key');
    const invoice = await creditSale(customerId, 5, 200);
    const key = crypto.randomUUID();
    const payload = {
      customerId,
      invoiceId: invoice.id,
      docDate: '2026-07-10',
      lines: [{ productId, qty: 1, rate: 200 }],
      creditNote: 200,
      reason: 'replay',
    };

    const first = await SELF.fetch('https://api.test/api/sales/returns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie, 'Idempotency-Key': key },
      body: JSON.stringify(payload),
    });
    expect(first.status).toBe(201);
    const original = await first.json<{ returnNo: string; totalPaisa: number }>();

    const again = await SELF.fetch('https://api.test/api/sales/returns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie, 'Idempotency-Key': key },
      body: JSON.stringify({
        ...payload,
        lines: [{ productId, qty: 2, rate: 200 }],
        creditNote: 400,
      }),
    });
    expect(again.status).toBe(201);
    const replay = await again.json<{ returnNo: string; totalPaisa: number }>();
    expect(replay.returnNo).toBe(original.returnNo);
    expect(replay.totalPaisa).toBe(original.totalPaisa); // not 40000
  });

  it('refuses to reuse a request key on a different bill', async () => {
    // Reusing the key would silently drop the second return while telling the
    // counter it went through.
    const customerId = await newCustomer('Key Two Bills');
    const a = await creditSale(customerId, 4, 200);
    const b = await creditSale(customerId, 4, 200);
    const key = crypto.randomUUID();

    const one = await SELF.fetch('https://api.test/api/sales/returns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie, 'Idempotency-Key': key },
      body: JSON.stringify({
        customerId,
        invoiceId: a.id,
        lines: [{ productId, qty: 1, rate: 200 }],
        creditNote: 200,
        reason: 'first bill',
      }),
    });
    expect(one.status).toBe(201);

    const two = await post('/api/sales/returns', {
      customerId,
      invoiceId: b.id,
      lines: [{ productId, qty: 1, rate: 200 }],
      creditNote: 200,
      reason: 'second bill',
    });
    // `post` generates a fresh key, so this control case succeeds.
    expect(two.status).toBe(201);

    const clash = await SELF.fetch('https://api.test/api/sales/returns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie, 'Idempotency-Key': key },
      body: JSON.stringify({
        customerId,
        invoiceId: b.id,
        lines: [{ productId, qty: 1, rate: 200 }],
        creditNote: 200,
        reason: 'second bill again',
      }),
    });
    expect(clash.status).toBe(409);
  });

  it('refuses a credit note for a customer who owes nothing', async () => {
    // Posting it anyway would leave a negative balance with no document to explain it.
    const customerId = await newCustomer('Owes Nothing');
    const sale = await post('/api/sales', {
      customerId,
      lines: [{ productId, qty: 2, rate: 200 }],
      paidCash: 400,
      cashAccountId: 'ca_counter',
    });
    const invoiceId = (await sale.json<{ sale: { id: string } }>()).sale.id;

    const res = await post('/api/sales/returns', {
      customerId,
      invoiceId,
      lines: [{ productId, qty: 1, rate: 200 }],
      creditNote: 200,
      reason: 'tried to credit a clear account',
    });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toMatch(/owes nothing/i);
  });

  it('refuses to return more than was sold on the invoice', async () => {
    const customerId = await newCustomer('Over Returns');
    const invoice = await creditSale(customerId, 2, 200); // only 2 units

    const res = await post('/api/sales/returns', {
      customerId,
      invoiceId: invoice.id,
      lines: [{ productId, qty: 5, rate: 200 }],
      creditNote: 1000,
      reason: 'more than he bought',
    });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toMatch(/can still be returned/i);
  });

  it('counts earlier returns, so the same unit cannot come back twice', async () => {
    const customerId = await newCustomer('Double Returner');
    const invoice = await creditSale(customerId, 5, 200);

    const first = await post('/api/sales/returns', {
      customerId,
      invoiceId: invoice.id,
      lines: [{ productId, qty: 3, rate: 200 }],
      creditNote: 600,
      reason: 'three back',
    });
    expect(first.status).toBe(201);

    // 3 already back, 5 sold: only 2 can still go.
    const tooMany = await post('/api/sales/returns', {
      customerId,
      invoiceId: invoice.id,
      lines: [{ productId, qty: 3, rate: 200 }],
      creditNote: 600,
      reason: 'three more',
    });
    expect(tooMany.status).toBe(400);
    expect((await tooMany.json<{ error: string }>()).error).toMatch(/Only 2 unit/);

    const allowed = await post('/api/sales/returns', {
      customerId,
      invoiceId: invoice.id,
      lines: [{ productId, qty: 2, rate: 200 }],
      creditNote: 400,
      reason: 'the last two',
    });
    expect(allowed.status).toBe(201);
  });

  it('refuses a return that does not add up', async () => {
    const customerId = await newCustomer('Bad Arithmetic');
    const invoice = await creditSale(customerId, 5, 200); // Rs 1000

    const res = await post('/api/sales/returns', {
      customerId,
      invoiceId: invoice.id,
      lines: [{ productId, qty: 1, rate: 200 }], // Rs 200
      creditNote: 500,
      reason: 'numbers do not match',
    });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toMatch(/must equal the return value/i);
  });

  it("refuses another customer's invoice", async () => {
    const owner = await newCustomer('Real Owner');
    const invoice = await creditSale(owner, 5, 200);
    const stranger = await newCustomer('Not His Invoice');

    const res = await post('/api/sales/returns', {
      customerId: stranger,
      invoiceId: invoice.id,
      lines: [{ productId, qty: 1, rate: 200 }],
      refundCash: 200,
      cashAccountId: 'ca_counter',
      reason: 'wrong customer',
    });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toMatch(/different customer/i);
  });

  it('requires a reason', async () => {
    const customerId = await newCustomer('No Reason');
    const invoice = await creditSale(customerId, 5, 200);

    const res = await post('/api/sales/returns', {
      customerId,
      invoiceId: invoice.id,
      lines: [{ productId, qty: 1, rate: 200 }],
      creditNote: 200,
      reason: 'x',
    });
    expect(res.status).toBe(400);
  });

  it('settles the invoice on the return date and reverses the cost of goods sold', async () => {
    const customerId = await newCustomer('Settles By Return');
    const invoice = await creditSale(customerId, 4, 200); // Rs 800 owed

    const res = await post('/api/sales/returns', {
      customerId,
      invoiceId: invoice.id,
      docDate: '2026-08-09',
      lines: [{ productId, qty: 4, rate: 200 }],
      creditNote: 800,
      reason: 'all four returned unused',
    });
    expect(res.status).toBe(201);

    // The invoice must read as cleared by a credit note, dated.
    const detail = await (await get(`/api/sales/${invoice.id}`)).json<{
      payment: { outstandingPaisa: number; clearedOn: string | null; history: { kind: string; date: string }[] };
    }>();
    expect(detail.payment.outstandingPaisa).toBe(0);
    expect(detail.payment.clearedOn).toBe('2026-08-09');
    const note = detail.payment.history.find((h) => h.kind === 'credit note')!;
    expect(note.date).toBe('2026-08-09');

    // Profit: the sale booked revenue 800 and cogs 400 (4 x Rs 100 avg cost).
    // After a full return neither should remain.
    const pnl = await DB.prepare(
      `SELECT
         COALESCE((SELECT SUM(credit_paisa) FROM ledger_entries WHERE account_type = 'sales'), 0)
       - COALESCE((SELECT SUM(credit_paisa) FROM ledger_entries WHERE account_type = 'sale_return'), 0)
         AS revenue,
         COALESCE((SELECT SUM(debit_paisa) FROM ledger_entries WHERE account_type = 'cogs'), 0)
       - COALESCE((SELECT SUM(credit_paisa) FROM ledger_entries WHERE account_type = 'cogs'), 0)
         AS cogs`,
    ).first<{ revenue: number; cogs: number }>();

    expect(pnl!.cogs).toBe(0); // cost fully reversed
  });

  it('posts the same return only once when the key repeats', async () => {
    const customerId = await newCustomer('Double Tap');
    const invoice = await creditSale(customerId, 5, 200);
    const key = crypto.randomUUID();
    const body = JSON.stringify({
      customerId,
      invoiceId: invoice.id,
      lines: [{ productId, qty: 1, rate: 200 }],
      creditNote: 200,
      reason: 'tapped twice',
    });
    const send = () =>
      SELF.fetch('https://api.test/api/sales/returns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie, 'Idempotency-Key': key },
        body,
      });

    expect((await send()).status).toBe(201);
    await send();

    // One return, not two: 5 sold, 1 back, so 4 remain returnable.
    const check = await (await get(`/api/sales/${invoice.id}/returnable`)).json<{
      lines: { returnable_milli: number }[];
    }>();
    expect(check.lines[0].returnable_milli).toBe(4000);
    expect(await owedBy(customerId)).toBe(80000); // 1000 - 200, once
  });
});
