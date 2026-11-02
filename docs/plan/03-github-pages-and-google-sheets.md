# Evaluation: GitHub Pages + Google Sheets as the platform

**Question:** can the front-end live on GitHub Pages and the data in Google Sheets?
**Short answer:** Pages — *no, not for this* (terms). Sheets as the **primary database** — *no* (it will work for a year, then hurt). But Sheets as a **reporting mirror + backup destination** — *yes, and we should do it.*

---

## 1. GitHub Pages — the problem isn't technical

Pages is excellent free static hosting. For this app the blocker is licensing, and it's the same wall Vercel hit:

> GitHub's Pages policy: it "is not intended for or allowed to be used as a free web hosting service to run your online business, e-commerce site, or any other website that is primarily directed at either facilitating commercial transactions or providing commercial software as a service (SaaS)."

A shop's billing and credit ledger is *literally* a system for facilitating commercial transactions. This is a clearer violation than the Vercel case, not a grey area.

Two more constraints, in order of annoyance:

| Constraint | Detail |
|---|---|
| **Public repo required** | Free plan publishes Pages only from public repositories. Private-repo Pages needs GitHub Pro ($4/mo). Your schema and business logic would be world-readable — legal, but you're handing over the schema of your books |
| **No backend at all** | Pages serves files. It cannot hold a secret, cannot validate a request, cannot compute a total |

Numeric limits (1 GB site, 100 GB/mo bandwidth, 10 builds/hr) are all irrelevant — you'd use well under 1%.

**Note:** this doesn't kill the *idea* of free static hosting. **Cloudflare Pages** does the same job, allows commercial use, doesn't require a public repo, and has unlimited static bandwidth. Whatever we decide, the front-end has a legitimate free home. That's not the interesting part of your question.

---

## 2. Google Sheets as the database — technically possible, structurally wrong

This is the part worth arguing about, because "Sheets as a backend" is a real, widely used pattern (Apps Script `doGet`/`doPost` → Sheets). It genuinely ships. The question is what happens at month 14.

### 2.1 The one that matters: no transactions

A sale is a *compound* fact. One invoice = invoice row + 4 line rows + 4 stock decrements + 2 ledger entries + 1 cash entry + invoice-number increment. Either all of it happened or none of it did.

Sheets has no transaction boundary. Apps Script appends row by row. If the 6-minute execution limit trips (or the network drops, or the phone sleeps mid-request), you can end up with **the invoice written and the stock not decremented** — silently. The system then tells you a product is in stock when it isn't, and the customer's balance is right for a sale the stock ledger never saw.

D1's atomic `batch()` makes this class of bug *structurally impossible*. Sheets makes it a bug you fix by hand, months later, from memory.

Practical consequence for your **"credit should be visible when issuing a new order"** requirement: the credit figure and the sale must be one atomic decision. Sheets gives you "read the balance, then later write the sale" — and in that gap, a second bill (or a double-tapped submit) produces **two invoices, two stock deductions, one customer who owes double what the screen said**.

Workarounds exist — `LockService` to serialise writes, an idempotency key column to reject duplicates. But you're hand-building a transaction manager out of string comparisons, in a spreadsheet, for a ledger.

### 2.2 It runs out of room — and the ceiling is surprisingly close

| Limit | Value | What it means here |
|---|---|---|
| **Cells per spreadsheet** | **10,000,000** | Our estimate: ~360k rows/year × ~10 columns ≈ **3.6M cells/year** → **~2.5–3 years per sheet**, then you must split by year |
| Formatted-but-empty cells | Also count | The classic trap — pre-formatting 5,000 rows × 20 columns burns a million cells of nothing |
| Max rows per sheet | 10 million cells is the binding limit | Not rows — cells |
| Sheet size for practical speed | ~50–100k rows | Reads slow down long before the hard cap |

Splitting the ledger into `ledger-2026`, `ledger-2027` is the standard escape. It works until a customer's outstanding balance spans two years — which, for a shop with carry-forward credit, is *the normal case*, not the edge case. Now every balance calculation is a fan-out across N sheets.

### 2.3 Speed: the counter will feel it

Every Apps Script web-app request pays 1–3 s before doing any work. Then business logic implemented against Sheets typically means several `getDataRange().getValues()` calls, each loading whole columns into memory.

| Stage | Per-bill feel (estimate) |
|---|---|
| Day 1 (a few thousand rows) | 1–3 s — acceptable |
| Month 6 (~60k rows) | 3–6 s |
| Year 2 (split sheets) | 6–15 s, dashboards 20 s+ |

On Cloudflare Workers + D1: **150–400 ms** for the same bill, and flat as data grows because reads use indexes.

Sitting across a counter from a farmer while a bill takes eight seconds is the difference between software the manager uses and software the manager abandons.

### 2.4 No schema, so no such thing as "totals of all companies"

Your requirement was company-wise totals for Tahafuz / SunCrop / Engro / Syngenta. With no foreign keys and no enforced vocabulary, a free-text cell typed `Suncrop` — or `Sun Crop`, or with a trailing space — quietly becomes a **fifth company** with its own totals that appear in no report you trust. Same for products (`Kan Ram` vs `Kan-Ram`), and each duplicate silently splits stock into two rows that individually show zero.

This is *the* classic spreadsheet erosion: it doesn't explode, it drifts. You discover the drift when monthly totals don't reconcile and nobody can say since when.

### 2.5 The daily quota picture (consumer Google account, verified 2026)

| Quota | Consumer limit | Our peak need | Headroom |
|---|---|---|---|
| Execution time per run | 6 min (hard, unpurchasable) | < 5 s | Fine |
| Total daily trigger runtime | 90 min | ~2 min | Fine |
| UrlFetch calls/day | 20,000 | ~2,000 | Fine |
| Concurrent executions per user | 30 | 1–3 | Fine |
| Sheets writes | ~300 requests/min/project | ~30 | Fine |

**Honest finding:** the quotas are *not* the problem. Everything fits. The problem is architecture — atomicity, growth, and latency. I want to be clear about that rather than hiding behind scary quota numbers that wouldn't actually bite you.

---

## 3. What Sheets is genuinely good at — and we should use

Your instinct isn't wrong; it's just pointed at the wrong layer. Four real wins:

1. **A live mirror of the books the manager can see, filter, chart, and pivot.** Nightly (or hourly) push of invoices, ledgers, and stock into a workbook. Zero learning curve, and pivots answer questions we never built reports for. **Keep this.**
2. **Bulk import.** Opening stock and opening customer balances typed into a template sheet, uploaded once. Far nicer than 800 manual product entries.
3. **Backup destination.** Google Drive is 15 GB free and off-site from Cloudflare. Nightly `.sql` + CSV exports to Drive *and* R2 *and* a private repo = three independent copies. **Adopt.**
4. **Expenses from the phone.** If the manager wants to log expenses by typing into a sheet or a Google Form, support it as an *input channel* that syncs into the D1 ledger. Cheap to build, genuinely useful.

So: Sheets as a **window and a mailbox onto the data**, not as the **engine**.

---

## 4. Three ways to build it — compared

| | **A1** Pages + browser → Sheets API (no backend) | **A2** Pages + Apps Script Web App → Sheets | **A3** Pages + Workers + D1 ⭐ |
|---|---|---|---|
| **Free?** | Yes | Yes | Yes |
| **Commercial use allowed?** | ❌ Pages policy | ❌ Pages policy (front-end is still Pages) | ✅ Cloudflare |
| **Atomic sale** | ❌ | ⚠️ Only via LockService + hand-built idempotency | ✅ Native `batch()` |
| **Price of a sale call** | 1–4 s, degrades | 2–8 s, degrades | 150–400 ms, flat |
| **Data ceiling** | 10M cells | 10M cells | 500 MB–5 GB, then $5/mo to lift |
| **Integrity (FKs, enums)** | none | none (validated in code only) | none in SQLite, but enforced by schema+API |
| **Where business logic lives** | In the browser — bypassable, unversioned | In a script bound to a spreadsheet | In one API codebase |
| **Real backups** | Sheets version history only | Sheets version history only | Nightly SQL export, 3 destinations |
| **Breaks at** | ~6 months | ~12–18 months | ~3 years at 500 MB (then archive or $5) |
| **Migration cost later** | High — data has drifted | High | Low — portable SQL |

**If you insist on Sheets-only, you must follow these rules or it will hurt:**
- Ledger sheets are **append-only**, never edited in place.
- **No formulas** inside data tabs — every computed number lives in a separate report tab, or is produced by the app.
- All writes wrapped in `LockService.getScriptLock()`, all endpoints idempotent via a client-supplied key.
- One spreadsheet **per year**, and a reconciliation tab that proves `sum(ledger) == outstanding` per customer at month end.
- Daily export to Drive as CSV, so a corrupted workbook is survivable.
- Cap SKUs and customers, and never edit a product name — only deactivate and re-add.

That's a lot of discipline to impose on a shopkeeper's system. It's the kind of discipline that lasts until the first busy afternoon.

---

## 5. Recommendation

- **Front-end:** Cloudflare Pages. Free, commercial use allowed, no public repo needed, unlimited static bandwidth. *(GitHub Pages would fail its own terms; use it only for the open-source repo mirror if we ever publish one.)*
- **Data:** Cloudflare D1. Atomic writes, indexed reads, 3-year headroom at zero cost, $5/mo escape hatch.
- **Google's role:** Sheets mirror for browsing and pivots, import template for opening data, Drive as one of three nightly backup destinations, optional expense input channel.

You keep every benefit you were reaching for — zero cost, data you can open and touch in Google, absolute ownership — and you drop the two things that would bite you (a transactional ledger living in a spreadsheet, and a hosting policy that forbids the app outright).

---

## 6. Decision needed

1. Accept **A3** (Cloudflare + D1 + Sheets mirror), or
2. Accept **A2** (Sheets as the engine, Pages front-end) — in which case we re-scope: no stock-movement ledger, no audit trail, degrade gracefully by year, and the terms issue stays open, or
3. Something else entirely (Supabase / Neon / Oracle VM) from `02-architecture.md`.
