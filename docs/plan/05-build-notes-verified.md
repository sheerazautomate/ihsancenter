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

---

## Two screens that existed and could not be reached

The manager asked for "a customers tab". There was already a full Customers page —
search, list with outstanding balances, per-customer ledger — **and no link to it in
the navigation**. The route was registered, so typing `/customers` worked; nothing
suggested it existed. Same shape as the missing product form: the code was fine, the
path to it was not.

Also added:

- **Product editing.** There was no `PATCH /catalog/products/:id` at all — a typo in a
  sale rate meant a new product and an orphaned old one.
- **Customer editing.** `PATCH /api/customers/:id` existed and was unused. Phone,
  village, credit limit and the credit hold are now editable, and customers can be
  created from the tab rather than only from the billing screen.

### What is deliberately *not* editable, and why

Both edit forms refuse fields that would quietly corrupt the books:

| Field | Why it is locked |
|---|---|
| `qty_on_hand` | Stock moves through purchases, sales and returns. An editable count is how a system ends up with a shelf that disagrees with its ledger. |
| product `company_id` | It decides which payable a purchase hits and how company totals report. Moving it restates history. |
| `avg_cost_paisa` | Derived from purchases, not typed. |

A rate change is **forward-only**: invoice lines store their own rate, so raising a
product's price never rewrites a bill already given to a farmer. The endpoint returns
how many past lines now sit beside the new rate, and the UI says so in words —
otherwise a manager assumes the change applied retroactively and the reports look
wrong to them later. Verified directly: sold a line at Rs 20, raised the product rate
to Rs 30, and the invoice still read Rs 40 while the books stayed balanced.

**The `contractor` customer type was nearly shipped.** The form offered it, the
schema's CHECK constraint did not allow it (`farmer`, `dealer`, `walkin` only), so
every save would have failed at the database. Caught by reading the constraint instead
of trusting the form. The type list in the UI now mirrors the constraint, with a
comment saying so, because the next person to add an option will hit the same wall.

## Companies: the delete rule the shop asked for was not enough

The request was "a company with data can only be deleted when its book check is 0,
otherwise give error". That rule is necessary but not sufficient, and shipping it
alone would have corrupted the catalogue on the first attempt.

Measured on the demo dataset: **all four seeded suppliers had a zero balance**, and
all four owned products (2, 2, 3 and 2 respectively). A balance-only rule would have
offered "Delete" on every one of them. The delete would then have either failed on a
foreign key or orphaned the products that still pointed at the vanished company.
Four tables reference `companies(id)` — `products`, `purchases`, `purchase_returns`,
`supplier_payments` — plus the supplier and inventory ledger rows.

So deletion is gated on a dependency audit, in this order, and the message names the
blocker that stopped it:

1. non-zero balance — **and which way it runs**: "you still owe them Rs X" or
   "they owe you Rs X". The two are opposite problems; a single "owes money" message
   would send a shopkeeper to pay a debt that does not exist.
2. products belong to it
3. purchases or purchase returns exist
4. payments were made to it
5. ledger entries reference it

Everything short of that is reachable through **deactivate** instead: the company
leaves the purchase and payment dropdowns, and no history is touched. The screen shows
"Delete" disabled with the reason already on screen, rather than letting the manager
click and be refused.

`DELETE /api/catalog/companies/:id` returns 409 with `code: 'company_in_use'` and the
full usage block, so a client can explain itself without a second request.

### Two bugs the screen had on its first draft

- **Editing a company blanked its address and notes.** The edit form is filled from the
  list endpoint, which selected only `id, name, contact_person, phone, is_active`. The
  form therefore opened with empty address/notes, and saving wrote `null` over real
  values. A save that looks successful and silently deletes data. The list now selects
  every editable column, and a test asserts the values survive a round trip.
- **The blocker read "Cannot delete this company: You still owe 50000 paisa."** Raw
  paisa, to a shopkeeper. Now `formatPkr` renders it the same way the rest of the app
  does ("Rs 500.00"), and the sentence is lower-cased where it is spliced mid-sentence.

### One test-suite trap worth remembering

`vitest-pool-workers` refused to start with `mock-agent.cjs ... does not provide an
export named 'default'`. That is not a test failure: a stray `npm install` had hoisted
`workerd@1.20250718.0` over the version the pool pins. `npm ci` from the committed
lockfile restored it. When that error appears, reinstall from the lock before touching
any test or config.

## Payables: the other half of the money loop was missing

Udhaar (customers) had a complete screen: aging, a receipt form, allocation against
oldest invoices. The supplier side had nothing. `POST /api/purchases/payments` worked
and was ledger-tested, but no screen called it, so the only way to pay a company was
the "paid cash" box at the moment a purchase was booked.

The consequence was not cosmetic. Every credit purchase stayed open forever: the
payables report drifted from the real ledger, and no company could ever satisfy its
delete check, because its payable never reached zero.

`Purchases.tsx` held the evidence that this was known and abandoned --
`const [supplierPayments, setSupplierPayments] = useState(false)` and a
`{supplierPayments && null}` line that could never render anything. Both are gone.

**Payables** (`/payables`, next to Udhaar) is the mirror of the Udhaar screen:

- the companies with a payable, from `/reports/payables` -- which reads the supplier
  ledger, never purchases minus payments
- tap one: amount (pre-filled with the balance), cash/bank/cheque, account, date,
  reference
- below it, the unpaid bills that make up the figure, and every payment made so far

Balances are not allocated per bill the way invoices are per receipt. There is no
supplier allocation table, and inventing FIFO allocation would have implied a
precision the shop does not ask for: a supplier is paid, and the balance drops.

### Two guards, one of them found only by running it

Paying more than the balance is now refused, naming the actual figure ("The payable
is Rs 2,500.00; Rs 3,000.00 is more than that"). Without it the supplier ledger flips
negative and the shop appears to be holding the company's money with nothing
explaining why. Paying a company that is owed nothing is refused too -- that is an
expense, not a payable.

The second was a **500 on a retried payment**. The unit test asserted the balance was
right after a duplicate POST, which it was: the unique index blocked the second
insert. But the request returned 500 with "Something went wrong", so a manager whose
phone dropped the response would think the payment failed and try again. Purchases
already handled this (`replayed: true`, HTTP 200); supplier payments did not. Now they
do, and the test asserts the status code, not just the arithmetic -- the failure only
appeared against a real server, which is the argument for driving these screens live
rather than trusting a green suite.

## Deleting a customer: for mistakes, not for people

The request was narrow on purpose: delete a customer who was typed twice, or typed
who does not exist. That is the right scope, because a paper register never had the
problem — you crossed out a line. In the database you cannot cross out a customer who
owns twenty invoices.

So the delete is available, and it is gated on the same dependency audit as companies:

1. non-zero balance — **in either direction**: "they still owe Rs 12,000.00" or
   "they are holding Rs X of the shop's money". An advance is not a settled account.
2. invoices in their name
3. sale returns against them
4. receipts collected from them
5. any customer ledger entry

Anything with a single row of history is refused with a 409 that names the blocker,
and the screen shows the reason before the button is pressed — Delete is disabled with
the explanation beside it.

**The live run is what made the case.** A customer with one fully-paid cash sale had
`balancePaisa: 0` and `ledgerEntries: 0`: two checks said "safe to delete". Only the
invoice count stopped it. A balance-only rule would have deleted the customer and left
the invoice pointing at nothing.

### Two details worth keeping

- **`cust_walkin` must survive.** Billing posts cash sales against that row by id. It
  is excluded explicitly, `canDeactivate: false` as well, and the refusal message no
  longer says "deactivate instead" for it — the first version did, which would have
  sent the manager to a button that is not on the screen. Caught by running the delete
  against a live server, not by the test, which only checked the status code.
- **Deactivating has to be reversible.** `GET /api/customers` is still active-only by
  default, so billing and receipts cannot offer a hidden customer; `?all=1` brings them
  back for the management screen, which is the only place they could be restored from.
  Without that, hiding someone by mistake would be a one-way door. Both directions are
  tested.

The UI asks you to **type the name** to confirm rather than clicking OK. A duplicate
is deleted in two seconds; an accidental confirmation costs a customer's whole history.

## Collecting against the bill the customer names

Udhaar allocated every receipt **oldest first**, unconditionally. The API had
accepted an explicit `allocations` array since it was written, and validated it
properly — the screen simply never sent one, so a farmer who came to clear the bill
he was holding had his money applied to an older one. The receipt was correct; the
answer to "is my bill clear?" was not.

Now the unpaid-bill list in Udhaar is selectable. Tapping a bill pre-fills the amount
with exactly what that bill still owes and sends:

    allocations: [{ invoiceId: chosen.id, amount: min(amountPaid, billBalance) }]

"Clear selection" returns to oldest-first, so the old behaviour is still one tap away
and is still the default.

**The excess stays an advance.** If the customer hands over Rs 500 for a Rs 200 bill,
the screen allocates Rs 200 and the other Rs 300 lands as an advance, which the
receipt already reported. It must not silently clear a second invoice the customer
did not mention — that is how a shop ends up arguing about a bill nobody remembers
agreeing to settle. Tested explicitly.

### The printed invoice was the real bug

`GET /api/sales/:id` returned the invoice row and nothing about what had been paid
since. So a reprinted invoice — the copy a farmer keeps, and the one he checks when
he is asked for money — kept stating the full credit as outstanding after it had been
cleared. It now carries:

    payment: { settledPaisa, outstandingPaisa, overpaidPaisa, receipts[] }

and the printed receipt shows "Received since", "Still owed", a "PAID IN FULL" line,
and the list of receipts with dates and modes. `GET /api/sales` gained
`outstanding_paisa` and `pay_state` (`paid | settled | part | open`), so the Invoices
tab shows "still owed" beside the credited amount instead of repeating the original
figure forever.

Verified live: two credit invoices for the same farmer; clearing the newer one left
the older untouched and marked the cleared one `settled`; a part payment showed
`part` with the remainder, and the customer balance reconciled to the rupee
(12,000 opening + 700 new credit − 550 received = 12,150) with integrity ok.

## Logs and exports: everything, in one click

The ask was "each and every possible log, so my friend can view anything in a single
click". That shaped three decisions.

**One catalogue drives both ends.** `src/lib/reports-catalog.ts` holds every report as
{slug, title, description, columns, sql}. `/api/reports/export` serves that list, and
the Logs page renders itself from it — so a report added on the server appears in the
UI with no front-end change, and the two cannot drift apart. 23 reports across
Customers, Companies, Stock, Cash, Expenses and System.

**Amounts are rupees in the file.** Every money column divides by 100 in SQL. A
spreadsheet is read by humans, and paisa would force the reader to add a `/100` column
— which is precisely where somebody eventually gets it wrong by a factor of a hundred.

**Voided documents are included, marked as void.** Hiding them would make the export
lie by omission; the record has to show what was cancelled, not only what survived.
The app's own totals still exclude them, which is correct — the export is the evidence
trail, not the balance.

### The format took two attempts

The first version wrote SpreadsheetML 2003 with an `.xls` extension. It opened in
Excel and my own tests passed, but `xlrd` rejected it, and it is the format Google
Sheets and phone apps often refuse. The shop said xlsx preferred, and a file that a
farmer's phone cannot open is not a deliverable.

There is no zlib in the Workers runtime, so a real `.xlsx` needed a ZIP writer.
`src/lib/zip.ts` writes **stored** (uncompressed) entries — legal ZIP, no compression
needed, and the resulting workbook is a few hundred kilobytes instead of one hundred.
`src/lib/xls.ts` then builds genuine Office Open XML: inline strings, a money number
format, a frozen header row, an autofilter, and a green header band. Verified by
loading the output with openpyxl — real workbook, 18 sheets, numeric money cells with
`#,##0.00`, `freeze_panes = A2`.

SpreadsheetML survives as `?format=xls`, and CSV as `?format=csv`. CSV carries a UTF-8
BOM, without which Excel reads the file as ANSI and every customer name becomes
mojibake — for this shop, names it can no longer match to anyone.

### Excel's limits, handled

Sheet names are capped at 31 characters and forbid `: \ / ? * [ ]`. A naive slice of
the title produced sheets called "Cash flow — every rupee in and". The catalogue now
carries short names, duplicates get a suffix, and illegal characters are replaced.
Anything over 20,000 rows is truncated and flagged with an `X-Export-Truncated`
response header rather than silently cut.

### The everything workbook

`/api/reports/export/everything/all` is the single click: a Cover sheet listing every
sheet and what it answers, one sheet per report, and one sheet per customer and per
company that has any movement. One broken report does not cost the shop the whole
export — failures are collected and named on the Cover sheet under INCOMPLETE.

This is also the nearest thing to a backup that exists today. The free plan has none,
and the workbook is the only artefact that can be handed to another system intact.

## "On which date did he pay what"

A running total cannot answer this. "Received since Rs 1,200" is true and useless
when the farmer is holding three slips and wants to check each one against the bill
in his hand. The shop asked for dates, and dates are the whole point.

`GET /api/sales/:id` now returns a `history` array, oldest first:

    { date, document, kind: receipt|credit note, mode, amountPaisa, balanceAfterPaisa }

plus `clearedOn` (the date the bill reached zero, null while anything is still owed)
and `lastPaidOn`. Receipts and return credit notes are merged into one timeline and
sorted by date, because both reduce what the farmer owes and both have a date he
will look for.

**The printed invoice carries the table.** Date, receipt number, mode, paid, and the
balance after each payment — the last of which is the number that actually settles an
argument. Under it: "Cleared in full on 2026-04-02", or "Still owed Rs 1,500 after the
last payment on 2026-05-11". The PAID IN FULL stamp now carries its date.

**And the lists carry it too**, because a manager scanning bills should not have to
open each one: the Invoices tab shows the cleared date under a paid badge and
"last paid <date>" under a part-paid balance, and Udhaar's open-bill list shows how
much of each bill has already been paid.

The balance in the history is recomputed from the invoice's own credit figure, never
below zero, so a run of payments reads monotonically down to zero. `clearedOn` is set
only when the running balance actually reaches it; a part-paid bill reports null, and
that distinction is tested — showing a cleared date on an open bill would tell the
farmer he is done when he is not.

## Sales returns

A farmer brings back a bag of urea because it was the wrong grade, or half a drum of
pesticide because it did not work. Three things have to happen together, and if any
one of them is missed the books stop matching the shelf: the stock comes back in, the
sale is reversed, and the farmer is made whole — either with money or by clearing part
of his udhaar.

`POST /api/sales/returns` posts all three in one unit of work:

    Dr sale_return      total        Cr cash        refundCash
                                    Cr bank        refundBank
                                    Cr customer    creditNote
    Dr inventory        costTotal    Cr cogs        costTotal
    stock +qty, stock_movements.type = 'sale_return'

**A credit note can never exceed what the customer owes.** This is the rule that keeps
the ledger honest. If a farmer paid cash for a bag and then returns it, there is no
udhaar to reduce; crediting his account anyway would leave the shop showing money owed
to a person who never lent it anything, with no document explaining where it came from.
So the engine checks the balance and refuses: a cleared account must be refunded, not
credited. `GET /api/sales/:id/returnable` hands the screen the number it needs to
respect that — `owedByCustomerPaisa` — alongside each line's `returnable_milli`
(sold minus everything already returned on earlier returns of the same bill), so the
counter cannot promise back more than was ever sold.

**The refund must add up exactly.** Cash plus bank plus credit note has to equal the
return value to the paisa. Anything else is a rounding hole that surfaces months later
as a balance nobody can explain, so it is refused rather than absorbed.

**The return screen** is reached from the invoice ("Return goods"), because a return
only means something against a bill. Quantities start empty — a pre-filled "everything"
gets submitted by accident and puts stock back that never left. The refund split
defaults to the honest one: credit note up to what he owes, cash for the rest, with a
tickbox for the case where he already cleared the bill and simply wants his money back.
Editing either figure re-derives the other, so the total can never drift.

**A return is a dated settlement.** `SR-` credit notes appear in the invoice's payment
history next to receipts, on their own date, and they move `clearedOn` when they are
what finishes the bill — because from the farmer's side a returned bag and a handed-over
note both reduce what he owes by the same amount on the same day. `POST` honours
`Idempotency-Key`, so a double-tap on a slow connection returns the original `SR-`
number instead of booking the stock twice.

Cost of goods is reversed at the same average cost the sale used, so a full return
leaves profit at exactly zero rather than at whatever the price difference happened to
be that week.

### Three holes that only opened when the real API was driven

The suite passed and the feature was wrong in three places. Each one is now covered
by a test that fails without the fix.

**A return that named no invoice skipped the cap entirely.** `invoiceId` was optional,
and the per-line limit lived inside `if (invoice)`. Posting a return without one
returned 9 bags of a product whose bill had already had 3 come back off a 10-bag line
— stock that never existed, against a refund bigger than the bill. There is no way to
cap a return that does not say what it reverses, so `invoiceId` is now required by the
schema. A farmer who has lost his slip is served by looking the bill up, not by booking
stock back on trust.

**An idempotency replay reported the wrong amounts.** The collision handler echoed
*total*, *refundCash* and *creditNote* — the values from the **new** attempt — under the
**old** return number. A retry that asked for Rs 20,000 got back "SR-2026-00005, Rs
7,500", or "SR-…, Rs 20,000" describing a document that says Rs 7,500. It now re-reads
the stored row and returns what the books actually hold.

**Reusing a request key on a different bill silently discarded the return.** The insert
collided, the handler found the key's existing row on another invoice, and returned
`ok: true` with that old document — the second return was never written while the
counter was told it had been. That case is now `409` with a message naming the document
the key belongs to.

### A refund has to appear on the slip

The first version only listed credit notes in the invoice's payment history. A farmer
who had paid a bill in full and then returned a bag got **cash** — the balance moved by
nothing, so the row was filtered out entirely, and the one document meant to settle an
argument showed the return had never happened. Returns with money going out are now
part of the history on their own date, carrying `refundPaisa` and the mode `cash
refund`, with the balance column correctly unchanged. "He gave me Rs 5,600 back on 29
September" is now printed on the bill.

Reconciled end to end on a live D1 — 10 urea and 4 DAP on udhaar, 3 urea back as a
credit note, the balance cleared by receipt, 1 DAP back as cash:

    sales       -47,400      inventory  -30,400
    sale_return +13,100      cogs       +30,400
    cash        +34,300      SUM          0

Net revenue 34,300 against COGS 30,400 leaves 3,900 of profit — exactly the margin on
the 7 urea and 3 DAP that stayed sold.
