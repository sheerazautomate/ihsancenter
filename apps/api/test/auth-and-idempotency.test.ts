import { describe, it, expect, beforeEach } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { createUser, login, isLockedOut, resolveSession, changePassword } from '../src/lib/auth';
import { hashPassword, verifyPassword, measureHashCost, signSession, verifySession } from '../src/lib/crypto';
import { postSale } from '../src/lib/sales';
import { normaliseIdempotencyKey } from '../src/lib/idempotency';
import { rupeesToPaisa, qtyToMilli } from '../src/lib/money';

const DB = env.DB as D1Database;
const AUTH_ENV = { DB, SESSION_SECRET: 'test-secret-not-used-in-production' };

const PRODUCT = 'prod_auth';
const CUSTOMER = 'cust_auth';

beforeEach(async () => {
  const tables = [
    'login_attempts', 'audit_log', 'ledger_entries', 'stock_movements',
    'sales_invoice_lines', 'sales_invoices', 'doc_sequences', 'users',
  ];
  for (const t of tables) await DB.prepare(`DELETE FROM ${t}`).run();
  await DB.prepare(`DELETE FROM products`).run();
  await DB.prepare(`DELETE FROM customers WHERE id <> 'cust_walkin'`).run();

  await DB.batch([
    DB.prepare(
      `INSERT INTO customers (id, name, type, credit_limit_paisa, created_at)
       VALUES (?, 'Auth Customer', 'farmer', 0, '2026-01-01T00:00:00Z')`,
    ).bind(CUSTOMER),
    DB.prepare(
      `INSERT INTO products (id, company_id, name, category, purchase_rate_paisa,
         sale_rate_paisa, avg_cost_paisa, qty_on_hand_milli, created_at, updated_at)
       VALUES (?, 'co_tahafuz', 'Auth Product', 'herbicide', 10000, 20000, 10000, 10000000,
               '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    ).bind(PRODUCT),
  ]);
});

// ---------------------------------------------------------------------------
// The last unverified assumption from 04-data-model.md: can PBKDF2 fit inside a
// free Worker's 10 ms CPU budget? Measure it instead of guessing.
// ---------------------------------------------------------------------------
describe('PBKDF2 cost in the Workers runtime', () => {
  /**
   * Measured in workerd: 10k->1.8ms, 25k->4.4ms, 50k->8.6ms, 100k->16.9ms.
   * The free plan allows 10ms CPU per request, so the default must stay under
   * 50k iterations. This test fails if someone raises it without re-measuring.
   */
  it('keeps the default iteration count inside the free-plan CPU budget', async () => {
    // Deterministic half of the guarantee: the configured count.
    //
    // Wall-clock timing is deliberately NOT asserted here. Measured costs are
    // 1.8ms @10k and 16.9ms @100k (see docs/plan/05-build-notes-verified.md), but a
    // shared CI box under load produced 13ms for the same 25k hashes that cost
    // 4.4ms when measured in isolation. An assertion that fails on scheduler noise
    // trains people to ignore failures, so re-measure with `npm run bench` instead.
    const { DEFAULT_ITERATIONS } = await import('../src/lib/crypto');
    expect(DEFAULT_ITERATIONS).toBeLessThanOrEqual(50_000);
    expect(DEFAULT_ITERATIONS).toBeGreaterThanOrEqual(10_000);
  });

  it('produces distinct hashes for the same password (random salt)', async () => {
    const a = await hashPassword('same-password', 10_000);
    const b = await hashPassword('same-password', 10_000);
    expect(a.hash).not.toBe(b.hash);
    expect(await verifyPassword('same-password', a.hash, a.iterations)).toBe(true);
    expect(await verifyPassword('wrong-password', a.hash, a.iterations)).toBe(false);
  });

  it('rejects a tampered session token', async () => {
    const token = await signSession(
      { sub: 'usr_1', role: 'manager', ver: 1, exp: Math.floor(Date.now() / 1000) + 3600 },
      'secret',
    );
    expect(await verifySession(token, 'secret')).not.toBeNull();
    expect(await verifySession(token, 'different-secret')).toBeNull();

    const [body, sig] = token.split('.');
    const tampered = `${body}.${sig.slice(0, -2)}xx`;
    expect(await verifySession(tampered, 'secret')).toBeNull();
  });

  it('rejects an expired token', async () => {
    const token = await signSession(
      { sub: 'usr_1', role: 'manager', ver: 1, exp: Math.floor(Date.now() / 1000) - 10 },
      'secret',
    );
    expect(await verifySession(token, 'secret')).toBeNull();
  });
});

describe('login', () => {
  beforeEach(async () => {
    await createUser(DB, { name: 'Manager', username: 'manager', password: 'correct-horse-1' });
  });

  it('signs in with the right password', async () => {
    const result = await login(AUTH_ENV, { username: 'manager', password: 'correct-horse-1' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.user.role).toBe('manager');

    const user = await resolveSession(AUTH_ENV, result.token);
    expect(user?.name).toBe('Manager');
  });

  it('is case-insensitive on the username', async () => {
    const result = await login(AUTH_ENV, { username: 'MANAGER', password: 'correct-horse-1' });
    expect(result.ok).toBe(true);
  });

  it('gives the same message for a wrong password and an unknown user', async () => {
    const wrongPassword = await login(AUTH_ENV, { username: 'manager', password: 'nope' });
    const noSuchUser = await login(AUTH_ENV, { username: 'ghost', password: 'nope' });

    expect(wrongPassword.ok).toBe(false);
    expect(noSuchUser.ok).toBe(false);
    if (!wrongPassword.ok && !noSuchUser.ok) {
      expect(wrongPassword.error).toBe(noSuchUser.error);
    }
  });

  it('locks the account after 5 failed attempts', async () => {
    for (let i = 0; i < 5; i++) {
      const r = await login(AUTH_ENV, { username: 'manager', password: 'wrong', ip: '1.2.3.4' });
      expect(r.ok).toBe(false);
    }
    expect(await isLockedOut(DB, 'manager', null)).toBe(true);

    // even the correct password is refused while locked out
    const blocked = await login(AUTH_ENV, { username: 'manager', password: 'correct-horse-1' });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error).toMatch(/too many/i);
  });

  it('invalidates existing sessions when the password changes', async () => {
    const signedIn = await login(AUTH_ENV, { username: 'manager', password: 'correct-horse-1' });
    expect(signedIn.ok).toBe(true);
    if (!signedIn.ok) return;

    expect(await resolveSession(AUTH_ENV, signedIn.token)).not.toBeNull();

    const changed = await changePassword(DB, {
      userId: signedIn.user.id,
      currentPassword: 'correct-horse-1',
      newPassword: 'brand-new-password-2',
    });
    expect(changed.ok).toBe(true);

    // token_version was bumped, so the old cookie is dead
    expect(await resolveSession(AUTH_ENV, signedIn.token)).toBeNull();
  });

  it('rejects a short password at creation', async () => {
    await expect(
      createUser(DB, { name: 'X', username: 'x', password: 'short' }),
    ).rejects.toThrow(/at least 8/i);
  });
});

// ---------------------------------------------------------------------------
describe('idempotency (the double-tap problem)', () => {
  const baseSale = {
    docDate: '2026-11-02',
    customerId: CUSTOMER,
    cashAccountId: 'ca_counter',
    lines: [{ productId: PRODUCT, qtyMilli: qtyToMilli(2), ratePaisa: rupeesToPaisa(200) }],
    paidCashPaisa: rupeesToPaisa(400),
  };

  it('returns the SAME invoice when the same key is posted twice', async () => {
    const key = 'tap-abc-123';

    const first = await postSale(DB, { ...baseSale, idempotencyKey: key });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = await postSale(DB, { ...baseSale, idempotencyKey: key });
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(second.replayed).toBe(true);
    expect(second.sale.id).toBe(first.sale.id);
    expect(second.sale.invoiceNo).toBe(first.sale.invoiceNo);

    // exactly ONE invoice, ONE stock deduction
    const invoices = await DB.prepare(`SELECT COUNT(*) AS n FROM sales_invoices WHERE idempotency_key = ?`)
      .bind(key)
      .first<{ n: number }>();
    expect(invoices!.n).toBe(1);

    const stock = await DB.prepare(`SELECT qty_on_hand_milli AS q FROM products WHERE id = ?`)
      .bind(PRODUCT)
      .first<{ q: number }>();
    expect(stock!.q).toBe(10000000 - 2000); // deducted once, not twice
  });

  it('creates TWO invoices for two different keys', async () => {
    const a = await postSale(DB, { ...baseSale, idempotencyKey: 'key-a' });
    const b = await postSale(DB, { ...baseSale, idempotencyKey: 'key-b' });

    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.sale.id).not.toBe(b.sale.id);
    expect(a.replayed).not.toBe(true);
    expect(b.replayed).not.toBe(true);
  });

  it('still works with no key at all', async () => {
    const a = await postSale(DB, baseSale);
    const b = await postSale(DB, baseSale);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.sale.id).not.toBe(b.sale.id);
  });

  it('rejects a malformed key rather than storing it', async () => {
    expect(() => normaliseIdempotencyKey('bad key with spaces')).toThrow();
    expect(() => normaliseIdempotencyKey('x'.repeat(101))).toThrow();
    expect(normaliseIdempotencyKey('good-key_1:abc')).toBe('good-key_1:abc');
    expect(normaliseIdempotencyKey('   ')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('HTTP surface', () => {
  it('exposes health without auth', async () => {
    const res = await SELF.fetch('https://api.test/health');
    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean }>();
    expect(body.ok).toBe(true);
  });

  it('refuses protected routes without a session', async () => {
    const res = await SELF.fetch('https://api.test/api/sales');
    expect(res.status).toBe(401);

    const credit = await SELF.fetch(`https://api.test/api/sales/credit/${CUSTOMER}`);
    expect(credit.status).toBe(401);
  });

  it('bootstraps the first account, then refuses to bootstrap again', async () => {
    const first = await SELF.fetch('https://api.test/api/auth/bootstrap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Manager', username: 'manager', password: 'bootstrap-pass-1' }),
    });
    expect(first.status).toBe(201);

    const second = await SELF.fetch('https://api.test/api/auth/bootstrap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Intruder', username: 'intruder', password: 'another-pass-1' }),
    });
    expect(second.status).toBe(409);
  });

  it('signs in over HTTP and uses the session cookie for a protected route', async () => {
    await createUser(DB, { name: 'Manager', username: 'manager', password: 'signin-pass-1' });

    const loginRes = await SELF.fetch('https://api.test/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'manager', password: 'signin-pass-1' }),
    });
    expect(loginRes.status).toBe(200);

    const cookie = loginRes.headers.get('Set-Cookie');
    expect(cookie).toContain('ihsan_session=');
    expect(cookie).toContain('HttpOnly');

    const sessionCookie = cookie!.split(';')[0];

    const me = await SELF.fetch('https://api.test/api/auth/me', {
      headers: { Cookie: sessionCookie },
    });
    expect(me.status).toBe(200);
    const body = await me.json<{ user: { name: string } }>();
    expect(body.user.name).toBe('Manager');
  });

  it('posts a sale over HTTP and reports a retry as replayed', async () => {
    await createUser(DB, { name: 'Manager', username: 'manager', password: 'http-pass-1' });

    const loginRes = await SELF.fetch('https://api.test/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'manager', password: 'http-pass-1' }),
    });
    const sessionCookie = loginRes.headers.get('Set-Cookie')!.split(';')[0];

    const payload = {
      customerId: CUSTOMER,
      lines: [{ productId: PRODUCT, qty: 3, rate: 200 }],
      paidCash: 600,
      cashAccountId: 'ca_counter',
    };

    const first = await SELF.fetch('https://api.test/api/sales', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: sessionCookie,
        'Idempotency-Key': 'http-double-tap',
      },
      body: JSON.stringify(payload),
    });
    expect(first.status).toBe(201);
    const created = await first.json<{ sale: { id: string; invoiceNo: string }; replayed: boolean }>();
    expect(created.replayed).toBe(false);

    // the user taps again
    const retry = await SELF.fetch('https://api.test/api/sales', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: sessionCookie,
        'Idempotency-Key': 'http-double-tap',
      },
      body: JSON.stringify(payload),
    });
    expect(retry.status).toBe(200); // 200, not 201: nothing new was created
    const replay = await retry.json<{ sale: { id: string }; replayed: boolean }>();
    expect(replay.replayed).toBe(true);
    expect(replay.sale.id).toBe(created.sale.id);
  });

  it('returns 409 with a readable message when the credit limit is breached', async () => {
    await DB.prepare(`UPDATE customers SET credit_limit_paisa = 100000 WHERE id = ?`)
      .bind(CUSTOMER)
      .run();
    await createUser(DB, { name: 'Manager', username: 'manager', password: 'limit-pass-1' });

    const loginRes = await SELF.fetch('https://api.test/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'manager', password: 'limit-pass-1' }),
    });
    const sessionCookie = loginRes.headers.get('Set-Cookie')!.split(';')[0];

    // Rs 2,000 on credit against a Rs 1,000 limit
    const res = await SELF.fetch('https://api.test/api/sales', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
      body: JSON.stringify({ customerId: CUSTOMER, lines: [{ productId: PRODUCT, qty: 10, rate: 200 }] }),
    });

    expect(res.status).toBe(409);
    const body = await res.json<{ error: string; code: string }>();
    expect(body.code).toBe('credit_limit_exceeded');
    expect(body.error).toMatch(/credit limit/i);
  });

  it('serves the credit panel for the billing screen', async () => {
    await createUser(DB, { name: 'Manager', username: 'manager', password: 'panel-pass-1' });
    const loginRes = await SELF.fetch('https://api.test/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'manager', password: 'panel-pass-1' }),
    });
    const sessionCookie = loginRes.headers.get('Set-Cookie')!.split(';')[0];

    // Put Rs 60,000 on credit while the customer has no limit (0 = unlimited).
    const seeded = await postSale(DB, {
      docDate: '2026-11-02',
      customerId: CUSTOMER,
      lines: [{ productId: PRODUCT, qtyMilli: qtyToMilli(3000), ratePaisa: rupeesToPaisa(20) }],
    });
    expect(seeded.ok).toBe(true);

    // The manager then tightens the limit to Rs 50,000, below what is already owed.
    await DB.prepare(`UPDATE customers SET credit_limit_paisa = 5000000 WHERE id = ?`)
      .bind(CUSTOMER)
      .run();

    const res = await SELF.fetch(
      `https://api.test/api/sales/credit/${CUSTOMER}?pending=1000`,
      { headers: { Cookie: sessionCookie } },
    );
    expect(res.status).toBe(200);

    const body = await res.json<{
      credit: { outstandingPaisa: number; availablePaisa: number; wouldExceed: boolean };
    }>();
    expect(body.credit.outstandingPaisa).toBe(rupeesToPaisa(60000));
    // Limit 50,000 - outstanding 60,000 = -10,000 available
    expect(body.credit.availablePaisa).toBe(rupeesToPaisa(-10000));
    // A pending Rs 20,000 credit sale would exceed the (already breached) limit.
    const bigger = await SELF.fetch(
      `https://api.test/api/sales/credit/${CUSTOMER}?pending=20000`,
      { headers: { Cookie: sessionCookie } },
    );
    const biggerBody = await bigger.json<{ credit: { wouldExceed: boolean } }>();
    expect(biggerBody.credit.wouldExceed).toBe(true);
  });
});
