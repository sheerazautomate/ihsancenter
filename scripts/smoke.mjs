#!/usr/bin/env node
/**
 * Post-deploy smoke test.
 *
 * A deploy "succeeding" only means Cloudflare accepted the upload. The failures
 * that matter show up on the first real request, and each one has a distinct
 * signature:
 *
 *   500 on login        -> SESSION_SECRET was never set (the error handler hides it)
 *   404 on /reports     -> SPA fallback not configured; hard refresh is broken
 *   401 on every cookie -> API and SPA on different origins; the browser drops the cookie
 *   "no such table"     -> migrations were never applied to the remote database
 *
 * Usage:
 *   node scripts/smoke.mjs https://your-worker.workers.dev
 *   node scripts/smoke.mjs https://your-worker.workers.dev --user manager --password '...'
 *
 * Read-only unless credentials are given. Exit code 0 = the deployment works.
 */

const args = process.argv.slice(2);
const base = args.find((a) => a.startsWith('http'));
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const user = flag('user');
const password = flag('password');

if (!base) {
  console.error('Usage: node scripts/smoke.mjs https://your-worker.workers.dev [--user u --password p]');
  process.exit(2);
}

const root = base.replace(/\/$/, '');
let failures = 0;

function record(ok, label, detail = '') {
  if (ok) console.log(`  ok    ${label}${detail ? `  (${detail})` : ''}`);
  else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? `  (${detail})` : ''}`);
  }
}

/** Interpret a JSON body that is actually an error the status code did not reveal. */
function apiError(body) {
  try {
    const j = JSON.parse(body);
    return j.error ?? j.code ?? null;
  } catch {
    return null;
  }
}

console.log(`Smoke testing ${root}\n`);

// ---------- 1. the API is up ----------
try {
  const res = await fetch(`${root}/health`);
  const body = await res.text();
  record(res.status === 200, 'GET /health', `${res.status}`);
  if (res.status !== 200) console.log(`        body: ${body.slice(0, 200)}`);
} catch (e) {
  record(false, 'GET /health', e.message);
  console.log('\nThe host did not answer at all — check the URL and that the deploy finished.');
  process.exit(1);
}

// ---------- 2. the SPA is served, including deep links ----------
try {
  const res = await fetch(`${root}/`, { headers: { accept: 'text/html' } });
  const body = await res.text();
  const isHtml = /<!doctype html>/i.test(body);
  record(res.status === 200 && isHtml, 'GET / serves the app', `${res.status}`);
  if (res.status === 200 && !isHtml) {
    console.log('        Got a 200 that is not HTML — the assets binding may point at the wrong directory.');
  }
} catch (e) {
  record(false, 'GET /', e.message);
}

for (const path of ['/reports', '/opening', '/invoices']) {
  try {
    const res = await fetch(`${root}${path}`, { headers: { accept: 'text/html' } });
    const body = await res.text();
    const isHtml = /<!doctype html>/i.test(body);
    record(res.status === 200 && isHtml, `GET ${path} (hard refresh)`, `${res.status}`);
    if (res.status === 404) {
      console.log(`        SPA fallback is broken: not_found_handling must be "single-page-application".`);
    }
  } catch (e) {
    record(false, `GET ${path}`, e.message);
  }
}

// ---------- 3. the database answers ----------
// /api/auth/me is unauthenticated-safe: a 401 proves the route ran AND the DB
// is readable, because the session lookup queries it. A 500 here means the
// database is unreachable or migrations were never applied.
try {
  const res = await fetch(`${root}/api/auth/me`);
  const body = await res.text();
  record(res.status === 401, 'GET /api/auth/me is guarded', `${res.status}`);
  if (res.status >= 500) {
    const err = apiError(body);
    console.log('        Server error from an unauthenticated route — this is almost always');
    console.log('        migrations not applied to the remote database, or a missing D1 binding.');
    if (err) console.log(`        reported: ${err}`);
  }
} catch (e) {
  record(false, 'GET /api/auth/me', e.message);
}

// ---------- 4. signed-in reads ----------
if (user && password) {
  const login = await fetch(`${root}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: user, password }),
  });
  const cookie = login.headers.get('set-cookie');
  const body = await login.text();
  record(login.status === 200, 'POST /api/auth/login', `${login.status}`);
  if (login.status >= 500) {
    console.log('        A 500 on login with correct credentials is the signature of a');
    console.log('        missing SESSION_SECRET. Set it: npx wrangler secret put SESSION_SECRET');
  } else if (login.status === 401) {
    console.log('        Wrong password, or no account yet. Create one with POST /api/auth/bootstrap');
    console.log('        (it only works while no user exists).');
  }

  if (login.status === 200 && cookie) {
    const auth = { headers: { cookie: cookie.split(';')[0] } };

    // The session cookie must survive a round trip. If the SPA and API were on
    // different origins in the browser, this is the request that would fail there.
    const me = await fetch(`${root}/api/auth/me`, auth);
    record(me.status === 200, 'session cookie accepted', `${me.status}`);

    for (const [path, check] of [
      ['/api/catalog/stock', (j) => Array.isArray(j.stock)],
      ['/api/reports/dashboard', (j) => typeof j.totalReceivablePaisa === 'number'],
      ['/api/opening', (j) => typeof j.posted === 'boolean'],
      ['/api/reports/integrity', (j) => j.ok === true],
    ]) {
      try {
        const res = await fetch(`${root}${path}`, auth);
        const text = await res.text();
        let parsed = null;
        try {
          parsed = JSON.parse(text);
        } catch {
          /* reported below */
        }
        const good = res.status === 200 && parsed && check(parsed);
        record(good, `GET ${path}`, `${res.status}`);
        if (!good && parsed?.error) console.log(`        ${parsed.error}`);
      } catch (e) {
        record(false, `GET ${path}`, e.message);
      }
    }

    // The books being unbalanced is not a deployment fault, but it is worth
    // knowing on the first day rather than the thirtieth.
    try {
      const res = await fetch(`${root}/api/reports/integrity`, auth);
      const j = await res.json();
      if (j.ok === true) {
        console.log('  ok    books balance (integrity check)');
      } else {
        console.log('  warn  integrity check reports a problem:');
        for (const d of j.unbalancedDocuments ?? []) console.log(`        unbalanced: ${d.doc_id}`);
        for (const d of j.stockDrift ?? []) console.log(`        stock drift: ${d.product_id}`);
      }
    } catch {
      /* already reported above */
    }
  }
} else {
  console.log('  skip  signed-in checks (pass --user and --password to include them)');
}

console.log('');
if (failures) {
  console.log(`${failures} check(s) failed — the deployment is not usable yet.`);
  process.exit(1);
}
console.log('All checks passed.');
