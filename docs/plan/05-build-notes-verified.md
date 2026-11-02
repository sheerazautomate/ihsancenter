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
| PBKDF2 vs the 10 ms CPU budget | **Still unverified** — login isn't built yet. First thing to measure when it is |

---

## Still open

1. **PBKDF2 iteration cost** on a free Worker (measure before choosing 100k).
2. **The 10 ms CPU ceiling for reports.** Aggregation time inside D1 is not billed
   to the Worker, but large result serialisation is. Needs a real report to measure.
3. **`db.batch()` size limits.** The 500-statement/1 MB guidance suggests chunking;
   a single sale is ~20 statements, so no issue yet, but year-end jobs will need it.

---

## What exists now

```
apps/api/
  migrations/0001_init.sql     schema, 20 tables, indexes
  migrations/0002_seed.sql     4 companies, 2 cash accounts, expense categories
  src/lib/money.ts             paisa/milli types, lakh-crore formatting, rounding
  src/lib/ids.ts               ULIDs generated in code (batch() can't return ids)
  src/lib/guard.ts             atomic invariant guards + failure diagnosis
  src/lib/numbering.ts         INV-2026-00042 sequences, Asia/Karachi business date
  src/lib/ledger.ts            double-entry builder, credit panel, aging SQL
  src/lib/sales.ts             postSale / voidSale
  test/sales.test.ts           18 tests against real D1
```

### The tested behaviours

- Split payment (cash + credit + bank) posts one balanced ledger
- Credit limit blocks a sale **atomically** — no invoice, no stock movement, no ledger row
- Manager override posts the sale and writes the reason to `audit_log`
- Insufficient stock blocks, including **two lines of the same product** jointly overselling
- Walk-in customers cannot take credit
- Void restores stock and reverses the ledger without deleting anything
- Credit panel reports limit / outstanding / available / aging / would-exceed
- Zero credit limit means "unlimited", not "no credit"

---

## Deliberate omissions in this slice

- **No HTTP layer yet.** `postSale` is a library function with tests; the Hono
  routes, auth middleware and request validation come next, so the business rules
  are proven before they are exposed.
- **No idempotency key** on posting yet. Required before the UI ships: a double-tap
  on "Save bill" must not create two invoices.
- **`qty_on_hand` concurrency.** The guarded `UPDATE` prevents negative stock, but
  two simultaneous sales of the last unit will race; one will be correctly rejected
  by the guard. Correct, but the loser sees an ugly error. Acceptable for one
  counter; revisit if a second till is added.
