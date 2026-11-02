# Build notes — what the first vertical slice proved

**Date:** 2026-11-02 · **Slice:** schema + money + ledger + sale posting + void + credit panel
**Status:** 18 tests passing against real D1 (vitest-pool-workers), typecheck clean.

This file exists because `04-data-model.md` §11 listed five assumptions to verify.
Five became six, and two of them changed the design. Recording them so nobody
re-derives them later.

---

## Verified: the guard mechanism works

`04-data-model.md` §6.2 proposed aborting a batch by inserting a row that violates
`tx_guard`'s `CHECK (code = 'ok')`. **Confirmed against real D1:**

- A failing statement inside `batch()` rolls back **every** statement in it.
- `INSERT INTO companies ...` followed by a guard violation leaves zero rows behind.
- Foreign keys are on by default in D1 (no `PRAGMA` needed — and `PRAGMA foreign_keys = ON;`
  in a migration file actually **fails** with `incomplete input`, so it was removed).

Test: `test/sales.test.ts` → "D1 batch atomicity (the assumption everything rests on)".

---

## Changed the design #1 — SQLite does not tell you which guard tripped

`interpretBatchError()` as drafted was a fiction. When a guarded batch fails, D1
reports:

```
D1_ERROR: CHECK constraint failed: code = 'ok': SQLITE_CONSTRAINT
```

That is the **constraint expression**, not the value we tried to insert. It is
identical for a credit-limit breach, a credit hold, and insufficient stock. There
is no way to distinguish them from the error alone.

**The fix turned out to be better than the original design.** Because the batch
rolled back, the database is provably unchanged — so after a guard failure we
re-read the relevant rows and name the cause truthfully:

```ts
if (isGuardFailure(err)) {
  const diagnosis = await diagnoseSaleFailure(db, { customerId, creditPaisa, lines });
  return { ok: false, error: diagnosis.detail, code: diagnosis.code };
}
```

This yields messages a shopkeeper can act on rather than a constraint dump:

> `Not enough stock for Tahafuz Kan Ram: available 3, requested 5`
> `Credit limit exceeded for Ali Khan: limit 1250, outstanding 60, this sale on credit 620`

It also means the *user-facing message is derived from the current state*, so it
can never disagree with reality. Tests for each of the three causes are in place.

**Trade-off:** the diagnosis costs one extra round trip, and only on the failure
path (a sale that is about to be rejected anyway). Accepted.

---

## Changed the design #2 — `julianday('now')` is not the shop's clock

Aging buckets were written as `julianday('now') - julianday(doc_date)`.
`'now'` is UTC. For a shop in Asia/Karachi (UTC+5), an invoice created at 02:00
local is timestamped the previous UTC day, so its age is off by one for the first
five hours of every day — enough to shift money across a bucket boundary.

**Fix:** pass the business date in as a parameter, computed in the Worker:

```ts
businessDate() // 'YYYY-MM-DD' via Intl with timeZone: 'Asia/Karachi'
```

Never let the database decide what "today" is.

---

## Non-issues, for the record

| Assumed risk | Reality |
|---|---|
| `PRAGMA foreign_keys` off | On by default in D1 |
| Integer division rounding on `(qty × rate) / 1000` | Half-up integer maths, no floats anywhere. Tested at 2.5 kg × Rs 400 and 3 × Rs 33.33 |
| PBKDF2 vs the 10 ms CPU budget | **Measured, and it changed the design** — see below |

---

## Changed the design #3 — 100k PBKDF2 iterations do not fit in 10 ms

The plan assumed 100,000 PBKDF2 iterations (a common interactive-login default) and
that it would probably fit. **Measured in workerd, the actual runtime:**

| Iterations | Time per hash |
|---|---|
| 10,000 | 1.8 ms |
| 25,000 | 4.4 ms |
| 50,000 | 8.6 ms |
| 100,000 | **16.9 ms** |

100k alone exceeds the free plan's 10 ms CPU budget, before session signing and the
D1 round trip. The default is now **25,000 iterations (~4.4 ms)**.

That is a genuine weakening of password hashing, so it is compensated for by two
other controls rather than left as a shrug: a fixed 700 ms delay on every failed
login, and a 5-attempt / 15-minute lockout. For one internal account on a private
URL that combination is defensible. Any future move to Workers Paid ($5/mo) should
raise this back to 100k immediately — the iteration count is stored per user, so
that is a code change with no migration.

> Measurement note: `performance.now()` returns 0 for the crypto call inside
> workerd's test runtime, so the first measurements looked like "0 ms at 100k
> iterations". Timing a batch of 10 hashes with `Date.now()` gave the real figures.
> Worth knowing before trusting any other microbenchmark in this environment.

---

## Changed the design #4 — a report can be "correct" and still be wrong

Two balances disagreed with each other, and both were found by using the app, not
by a test.

**Receivables.** The report was built from unpaid *invoices*, which is the natural
way to attach an age to a debt. But a shop's khata carries forward: a customer can
owe Rs 9,700 with no invoice behind it. That customer vanished from the report —
the screen said nobody owed anything while their statement showed the debt.

Fixed by taking the total from the **ledger** (SUM debit − credit, the figure that
can never disagree with a statement) and the aging from **invoices** (the only
place an age exists). Anything not attributable to an invoice is now surfaced as
`unappliedPaisa` rather than silently dropped.

**Payables.** The mirror-image mistake: computed as purchases minus payments. That
ignores any payment made against an opening balance or not tied to a purchase, so
paying a company Rs 50,000 left the payable unchanged on the report while the
dashboard showed the reduced figure. Two screens, two answers.

Fixed by reading the supplier ledger directly.

**The lesson, recorded so it is not relearned:** any figure shown to the manager
must have exactly one source. If two screens can compute the same number two
different ways, they will eventually disagree, and a shopkeeper who sees two
answers trusts neither. Every balance now comes from `ledger_entries`; aging is the
only derived view, and it reconciles to the ledger explicitly.

Both cases are regression-tested (`test/ledger-flows.test.ts`, "agrees with the
ledger" suites).

---

## Still open

1. **The 10 ms CPU ceiling for reports.** Aggregation time inside D1 is not billed
   to the Worker, but large result serialisation is. Needs a real report to measure.
2. **`db.batch()` size limits.** The 500-statement/1 MB guidance suggests chunking;
   a single sale is ~20 statements, so no issue yet, but year-end jobs will need it.
3. **Cross-worker session verification** costs one D1 read per request. At 2,000
   requests/day against a 5M row-read budget that is negligible, but it would be the
   first thing to cache if request volume ever grew.

---

## What exists now

```
apps/api/
  migrations/0001_init.sql     schema: 20 tables, indexes
  migrations/0002_seed.sql     4 companies, 2 cash accounts, expense categories
  migrations/0003_auth...sql   login attempts, idempotency unique keys
  src/lib/money.ts             paisa/milli types, lakh-crore formatting, rounding
  src/lib/ids.ts               ULIDs generated in code (batch() can't return ids)
  src/lib/guard.ts             atomic invariant guards + post-rollback diagnosis
  src/lib/numbering.ts         INV-2026-00042 sequences, Asia/Karachi business date
  src/lib/ledger.ts            double-entry builder, credit panel, aging SQL
  src/lib/sales.ts             postSale / voidSale, idempotent
  src/lib/crypto.ts            PBKDF2 (measured), HMAC session tokens
  src/lib/auth.ts              login, lockout, sessions, password change
  src/lib/idempotency.ts       key normalisation, collision detection
  src/middleware.ts            requireAuth / requireRole
  src/routes/auth.ts           /api/auth/*
  src/routes/sales.ts          /api/sales/*
  src/index.ts                 Hono app, CORS, error handling
  src/lib/purchases.ts         purchases, returns, supplier payments
  src/lib/receipts.ts          customer receipts + allocation, expenses
  src/lib/reports.ts           every report, each from a single source
  src/routes/{sales,purchases,money,reports,catalog,customers}.ts
  test/sales.test.ts                 18 tests
  test/auth-and-idempotency.test.ts  21 tests
  test/catalog.test.ts               9 tests
  test/ledger-flows.test.ts          18 tests
```

**66 tests.**

**39 tests, green under `--sequence.shuffle`.**

### The tested behaviours

**Posting**
- Split payment (cash + credit + bank) posts one balanced ledger
- Credit limit blocks a sale **atomically** — no invoice, no stock movement, no ledger row
- Manager override posts the sale and writes the reason to `audit_log`
- Insufficient stock blocks, including **two lines of the same product** jointly overselling
- Walk-in customers cannot take credit
- Void restores stock and reverses the ledger without deleting anything
- Credit panel reports limit / outstanding / available / aging / would-exceed
- Zero credit limit means "unlimited", not "no credit"

**Idempotency**
- Posting the same key twice returns the SAME invoice, one stock deduction
- Two different keys create two invoices
- No key at all still works (two invoices)
- Malformed keys are rejected, not stored
- Over HTTP: first request 201 `replayed: false`, the double-tap 200 `replayed: true`

**Auth**
- Correct password signs in; username is case-insensitive
- Wrong password and unknown user return an identical message (no account enumeration)
- 5 failed attempts locks out even a correct password
- Changing the password invalidates every existing session immediately
- Tampered and expired session tokens are rejected
- Bootstrap works once, then returns 409 forever

---

## Deliberate omissions in this slice

- **Sale returns have no route yet.** The table, ledger shape and idempotency key
  exist; only the UI and endpoint are missing.
- ~~No opening-balance entry screen.~~ **Done** — `/opening`, backed by
  `lib/opening.ts`. See "Changed the design #5" below.
- **No backup job yet.** The nightly `d1 export` + GitHub/R2 copy described in
  `02-architecture.md` is not written. This is the one piece of the plan that must
  exist before real money goes in.
- **`qty_on_hand` concurrency.** The guarded `UPDATE` prevents negative stock, but
  two simultaneous sales of the last unit will race; one will be correctly rejected
  by the guard. Correct, but the loser sees an ugly error. Acceptable for one
  counter; revisit if a second till is added.

---

## Changed the design #5 — the guard has to run *before* the write

Opening balances needed a rule with no threshold behind it: *this account may be
opened once, ever.* Any later posting is a correction, not an opening, and must go
through an adjustment instead.

The obvious implementation reused the existing `tx_guard` trick — put a `SELECT`
that yields a row when the rule is broken at the *end* of the batch, so the CHECK
fires and the whole batch rolls back. That is what the negative-stock guard does,
and it works there because the write and the check look at different things.

Here they look at the same thing. `ledger_entries` already contains the rows the
batch just inserted, so the guard found its own work, fired, and rejected a clean
first submission with `opening_already_posted`. Confusingly, it only failed when
money rows were present — a stock-only posting looked fine.

The fix is one line of ordering: guards go **first** in the batch. D1 runs batch
statements in order, so the guard sees the pre-batch state and the inserts follow.
A rejected attempt now also writes nothing at all, which is the property you
actually want.

**Lesson:** a guard must be evaluated against the state *before* the write it is
guarding. Appending a check to a batch is only safe when the check does not read
the rows the batch is about to create.

### Two smaller things this screen taught us

- **Equity is assets minus liabilities.** The first version of the capital figure
  flipped the sign, and the test that "looked wrong" was in fact the code being
  wrong in the opposite direction. If `assets - liabilities` is negative the shop
  owed more than it owned on day one; that is a debit balance in the capital
  account, and it is a real and reportable situation, not an error to hide.
- **A rule that lives only on the server reads as a mystery in the UI.** The screen
  locks rows that already carry an opening and shows the posted figure as text, so
  the manager never types an amount into a field that will be rejected.

---

## Deployment pass — three failures that look like success

None of these can be caught by a test suite, because all three happen after the code
is correct. They were found by running the deploy path locally and reading what the
tooling actually did.

**1. `wrangler d1 execute --file` is not idempotent, so a half-finished deploy is
unrecoverable.** Re-running `0001_init.sql` failed on the first `CREATE TABLE`, which
left no way forward and no way back: the obvious next step — "drop it and start over"
— is the one thing you must not do with real data in the table. Every migration now
uses `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` / `INSERT OR IGNORE`,
and the six idempotency columns live in `0001`'s `CREATE TABLE` instead of a separate
`ALTER TABLE` (which SQLite can never re-run). Verified: all three files applied
twice to a fresh database, clean both times. No production database existed yet, so
this was a free fix rather than a migration.

**2. Demo data in `migrations/` is a loaded gun.** `0004_demo_seed.sql` carried a
prominent "DO NOT RUN IN PRODUCTION" comment, which is worth nothing against
`migrations/*.sql` — a glob, a CI step, or a tired person at midnight. Fake customers
and fake stock cannot be deleted cleanly once they are posted to real books, so the
file now lives in `apps/api/demo/demo_seed.sql`, outside the directory that means
"apply this to the database". The preflight script fails if anything demo-like
reappears there.

**3. Deleting the local D1 file under a running dev server looks like a broken
secret.** `npm run db:reset:local` while `wrangler dev` was up left workerd holding a
path to a file that no longer existed; every query returned
`SQLITE_CANTOPEN: unable to open database file`, which the API's error handler turns
into the same generic 500 that a missing `SESSION_SECRET` produces. Two very different
causes, one symptom. The reset script now refuses to run while :8787 is listening and
prints why.

The general point: **a deployment is not done when the upload succeeds.** Each of
these was invisible until something ran against the deployed shape, which is why
`scripts/deploy-check.mjs` and `scripts/smoke.mjs` exist and why both were tested by
deliberately breaking the config and watching them fail.

---

## Deploying found what tests could not — three bugs in a row

The first real deployment produced three failures that the 77-test suite, `tsc`, and
`vite build` all passed straight over. None of them is an API bug: they live in the
seam between the code, the config, and the runtime, which is exactly the seam nothing
exercised.

**1. A renamed D1 binding.** `wrangler.toml` had `binding = "ihsancenter"` while every
route reads `c.env.DB`. The deploy succeeded and proudly printed the binding, but
`c.env.DB` was `undefined`, so the first query threw
`TypeError: Cannot read properties of undefined (reading 'prepare')`, which the error
handler reports as a generic 500. Migrations kept working because they address the
database by *name*, so the database looked fine right up until something queried it.
`deploy:check` now compares the toml binding against `c.env.*` in `src/` and refuses to
pass.

**2. `apiUrl()` was inverted.** The client helper read
`path.startsWith('/') ? path : '/api' + path`, and every caller passes `'/auth/login'`.
The prefix was therefore never added. In `vite dev` that request merely 404s against the
dev server, so nobody saw it; in production it hit the static-asset handler and came back
as **405** for a POST and **index.html with a 200** for a GET — which the app parsed as an
empty body and treated as "not signed in". Result: a site that loaded, looked fine, and
could not log in.

The lesson is about where that bug lived, not how long it was. It was not untested through
carelessness: it is *unreachable* in development because the dev server has no assets
handler to collide with. It only exists in the single-origin production shape. There is
now a 5-case unit test for `apiUrl`, a JSON parse guard that names the problem instead of
silently returning `{}`, and three smoke probes that assert the unprefixed path does *not*
reach the API.

**3. Nothing checked the seam after deploying.** Both of the above were visible in one
line of `wrangler tail` and would have been caught automatically by a post-deploy request
to `/api/auth/me` plus one to `/auth/me`. That is now `scripts/smoke.mjs`, which is worth
running on every deploy rather than only when something is already broken.

**Rule worth keeping:** a passing test suite says the logic is right. It says nothing
about whether the URL, the binding name, or the asset handler agree with it.

---

## The shop could not add its first product

Found the day the manager tried it: the Purchases screen showed `No match` for
"Delta 4" and there was nowhere to go. `POST /catalog/products` existed and was
tested, but **no screen called it**. Worse, `Stock.tsx` carried the line *"Products
are created when you record a purchase"* — which was also untrue, because Purchases
only searched existing products. A brand-new shop was a closed loop:

    Stock      read-only list
    Purchases  search only; "No match" was a dead end
    Opening    lists existing products
    Billing    cannot sell what does not exist

The endpoint being well-tested is exactly why this went unnoticed: the tests proved
the API works, and nothing proved a person could reach it. That is the same failure
mode as the `apiUrl` bug — correct code, no path to it.

Fixed in two places, because the two moments are different:

- **Stock → "+ New product"**: the catalogue entry. Name, company, type, pack size,
  unit, purchase and sale rate, reorder level, opening quantity. Opening quantity
  defaults to 0 and only records a movement when non-zero.
- **Purchases → "No match" → "+ Create…"**: creates the product inline and drops it
  straight into the purchase line, so receiving a new brand does not require leaving
  the invoice half-entered.

Two deliberate frictions: a sale rate is **required** (a product with no price cannot
be billed, and the failure would surface at the counter), and selling below cost asks
for confirmation rather than blocking — a clearance line is legitimate, a typo is not.
