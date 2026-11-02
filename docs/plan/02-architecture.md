# Ihsan Center — Phase 2: Architecture (DISCUSSION DRAFT v0.1)

**Constraint: PKR 0/month. Free tier only, must survive real shop use.**
**Status:** for discussion — no code written yet.

---

## 1. What "totally free" actually costs you

The dangerous part of a free-tier plan isn't the price, it's the **failure mode**. Some free tiers don't fail politely — they delete your data or refuse to serve you on a busy Saturday. I checked the current terms (Oct 2026) before recommending anything.

| Platform | Free tier reality (verified Oct 2026) | Verdict for a shop's books |
|---|---|---|
| **Vercel Hobby** | 100 GB transfer, 1M invocations — but fair-use rules (updated 14 Sep 2026): *"Hobby teams are restricted to non-commercial personal use only"*; they may remove Hobby deployments at their discretion | ❌ **Disqualified.** This is a business app. Pro is $20/mo |
| **Render** | Free web service sleeps after 15 min; **free Postgres expires 30 days after creation and is deleted 14 days later**; no backups | ❌ Unusable for a ledger |
| **Supabase** | 500 MB DB, 2 projects, **project pauses after 1 week of inactivity**, no automatic backups | ⚠️ Workable (shop is used daily) but a monsoon week off could pause it |
| **Neon** | 100 CU-hours/month, scale-to-zero after 5 min idle, 0.5–1 GB storage. ~300 shop-hours/month at 0.25 CU ≈ 75 CU-hrs | ⚠️ Fits *on paper*, with little headroom in peak season |
| **Cloudflare Workers + D1** | 100,000 requests/**day** (not month), 10 ms CPU per request, D1 free: 5 GB total, **500 MB per database**, 5M rows read/day, 100k rows written/day. No commercial-use restriction. No cold starts. | ✅ **Fits comfortably** — see capacity math in §9 |

Two rules fall out of that table:

1. **Never let a free tier with an expiry date hold the only copy of the books.** Backup strategy (§6) is part of the architecture, not an afterthought.
2. **Prefer tiers that fail soft** (rate-limited, recovers tomorrow) over tiers that fail hard (paused, deleted).

---

## 2. Candidate stacks

### Option A — Cloudflare all-in ⭐ recommended
`React SPA (Cloudflare Pages, static) + Hono API (Workers) + D1 (SQLite) + R2 (backups)`

- **Cost:** $0 forever, commercial use explicitly allowed, no inactivity pause, no cold start.
- **Why it fits:** a shop app is ~2,000 API calls/day against a 100,000/day budget. D1's write limit is 100k rows/day; peak season we write ~1,500. Wide margins.
- **Trade-offs:** D1 has no interactive `BEGIN/COMMIT` — writes must be planned as one atomic `batch()` (§7). SQLite dialect, not Postgres. Vendor lock-in unless we keep SQL portable.
- **Escape hatch:** if you ever outgrow it, **Workers Paid is $5/mo** and removes the request cap, the 10 ms CPU cap, and lifts D1 to 10 GB. One switch, no rewrite.

### Option B — Cloudflare Pages SPA + Workers API + **Neon Postgres**
- Same shape as A but Postgres instead of D1: real transactions, `numeric`, window functions, `pg_dump` backups, and painless migration to any VPS/Nest/Postgres host later.
- **Risk:** the 100 CU-hour meter. It's per project and scale-to-zero helps, but a heavy month runs out and you have no card on file — compute stops until the month rolls over. For a shop, that means **you can't bill on the 28th**.
- Good choice if the reason for free is "no card / no risk" rather than "must be free forever" — but it's the worse choice for uptime.

### Option C — Supabase (Postgres + Auth + Storage) + Pages SPA
- Fastest to build: auth, file storage (receipt photos, supplier invoices), and a polished dashboard for free. 500 MB DB.
- **Risk:** 7-day inactivity pause, no backups on free, 2-project cap. A daily GitHub Action ping mitigates the pause; nightly `pg_dump` mitigates the backup gap.
- Best if you want less custom code and accept a bit of babysitting.

### Option D — Oracle Cloud Always Free ARM VM, self-hosted
- 4 OCPU / 24 GB ARM forever free, run Postgres + Node + Caddy. Total control, real `pg_dump`, no CPU meters.
- **Risk:** needs a credit card for verification, reputation for account reclamation, and *you* are the sysadmin. Highest ops burden, highest control. Only if someone technical is around.

### Not viable in 2026
Railway, Fly.io, Koyeb, Heroku Eco ($5) — no lasting free compute. Render's free DB expires. Deta is gone.

---

## 3. Recommendation

**Option A — Cloudflare Workers + D1.** Reasoning, in priority order:

1. **It cannot surprise you with a bill** (no metered service will start charging without a card) and **cannot go to sleep**.
2. Capacity headroom is 50–100× our peak load, verified against published limits.
3. Static SPA hosting is unmetered — phone on mobile data costs us nothing in bandwidth.
4. If it does become too small, the fix is one $5/mo toggle, not a re-platform.

**Accepted pain:** SQLite dialect; writes must be batch-shaped; 500 MB is ~4–8 years at your volume, after which we archive old years to CSV/R2.

---

## 4. High-level architecture

```
 ┌─────────────────────────────────────────────┐
 │  Phone / laptop browser (PWA, installable)  │
 │  React + TS + Vite + TanStack Router/Query  │
 └───────────────┬─────────────────────────────┘
                 │ HTTPS, typed JSON (Hono RPC)
 ┌───────────────▼─────────────────────────────┐
 │  Cloudflare Workers — Hono API              │
 │  auth · validation (zod) · business rules   │
 │  every write = one atomic batch()           │
 └───────────────┬─────────────────────────────┘
                 │ D1 binding (SQLite)
 ┌───────────────▼─────────────────────────────┐
 │  D1 database: documents + ledger + stock    │
 └───────────────┬─────────────────────────────┘
                 │ nightly export
 ┌───────────────▼─────────────────────────────┐
 │  R2 bucket (10 GB free) + private GitHub repo│
 │  daily SQL export, 30-day retention          │
 └─────────────────────────────────────────────┘
```

- **Frontend and API are separate deployments.** Static assets on Pages (free, unlimited); API on Workers. No SSR — this app doesn't need SEO and SPA keeps us far from the 10 ms CPU ceiling.
- **Typed end-to-end:** Hono's RPC client means the frontend calls `api.invoices.create(...)` with compile-time types — no hand-written fetch wrappers, no drift.
- **No state management library.** TanStack Query for server state; ~4 small React contexts for the open bill.

---

## 5. Auth and security

Single manager account, but with a `users` table (one row, `role` column) so roles bolt on later without a migration.

| Concern | Approach |
|---|---|
| Password | Hash stored in `users`; login issues an HttpOnly + Secure + SameSite=Lax cookie |
| Session | HMAC-signed token, 30-day expiry, "remember this device" — log in once per phone/laptop, not daily |
| Brute force | Fixed 700 ms delay + lockout after 5 failures, counter in D1 |
| Transport | HTTPS only; Pages/Workers terminate TLS |
| Authorisation | Every API route behind middleware; no public endpoints except `/auth/login` and `/health` |
| Audit | `audit_log` row on every create/void/override — with real login, this becomes "manager did X at 4:12 pm" |
| Secrets | Wrangler secrets, never in the repo |

> ⚠️ **Known constraint:** PBKDF2 with 100k iterations can exceed the 10 ms CPU budget of a free Worker. Mitigation: PBKDF2-SHA256 with a reduced iteration count (tuned to ~5 ms, measured during build) plus the rate limit above — acceptable for one internal account on a private URL. If login ever errors on the free plan, move login to a tiny separate worker or budget $5. To be validated in build, not assumed.

---

## 6. Backup & disaster recovery (non-negotiable)

Free tiers give you **no backups**. Your books would live on exactly one disk. So:

1. **Nightly `wrangler d1 export`** via a scheduled GitHub Action (free minutes for private repos) → commits `backup-YYYY-MM-DD.sql` to a **private** GitHub repo and uploads to R2.
   - GitHub's history *is* the off-site copy. Free, versioned, and geographically separate from Cloudflare.
2. **30-day rolling retention** in R2 (10 GB free; a full-year export is ~50 MB).
3. **In-app "Download backup" button** — one tap, full `.sql` file to the phone. Run it before any risky operation.
4. **Monthly restore drill.** A backup nobody has restored is a guess. Restore into a scratch D1 database and check totals against the live dashboard. 10 minutes, once a month, on the 1st.
5. **CSV export on every report** — so the manager is never locked in even if the app dies.

---

## 7. Write model — no interactive transactions in D1

D1 gives us `batch()`: a list of statements runs as **one atomic transaction**, all or nothing. We can't read, decide, and write across multiple round trips inside a transaction. So every write is designed as: **validate in code → build the full statement list → execute as one batch.**

### Example: post a sale (Rs 10,000 = 4,000 cash + 6,000 udhaar, 4 lines)

```
read:  products (stock qty, avg cost), customer (limit, outstanding), next invoice no
check: stock sufficient?  credit_headroom >= 6,000?  amounts balance?
batch:
  1. INSERT invoices            (totals, paid_cash, paid_bank, credit_amount)
  2. INSERT invoice_lines × 4   (qty, rate, cost_at_sale snapshot)
  3. UPDATE products            stock_qty -= qty, for each line
  4. INSERT stock_movements × 4 (type='sale', ref=invoice)
  5. INSERT ledger ×2           (customer debit 10,000; credit received 4,000)
  6. INSERT cash_ledger ×1      (cash +4,000)
  7. UPDATE doc_sequences       next invoice no
  8. INSERT audit_log
```

If any statement fails, nothing is written. No half-posted invoices, ever.

The same shape applies to purchase posting, customer receipt, sale return, purchase return, and void — all specified in `03-data-model.md`.

**Concurrency:** one manager, one counter. Optimistic `UPDATE ... WHERE stock_qty >= ?` guards the one real race (two tabs on the same bill). No distributed locking, deliberately.

---

## 8. Money handling

**All amounts stored as integer paisa** (`INTEGER`, e.g. Rs 1,234.50 → `123450`). SQLite has no decimal type, and floats corrupt ledgers — `0.1 + 0.2 ≠ 0.3` would show up as a one-paisa gap in your customer balance that you can never explain.

- Arithmetic in integers; format at the edge: `Rs 1,23,456` display style to be confirmed (Western `1,234,567` shown by default).
- Discounts stored as they were entered (`discount_type` = pct | amount) **and** the computed paisa delta is stored on the document. Reprints show what the customer saw.
- Rounding: line totals round to nearest paisa; the invoice total is the **sum of stored line totals**, never recomputed. Any rounding difference is booked as an explicit `round_off` line, so documents always add up on paper.

---

## 9. Capacity math — will free hold?

Estimating a busy pesticide shop:

| Entity | Peak/day | Per year |
|---|---|---|
| Products (SKUs) | — | ~800 |
| Customers | — | ~1,500 |
| Invoices | 150 | ~23,000 |
| Invoice lines (avg 4) | 600 | ~92,000 |
| Purchases / purchase lines | 20 | ~7,000 |
| Payments (in + out) | 40 | ~13,000 |
| Stock movements | 700 | ~140,000 |
| Ledger rows | 300 | ~80,000 |
| **Total new rows/year** | **~1,600/day** | **~360,000** |

- **Writes:** 1,600/day vs **100,000/day** free limit → **1.6%** used.
- **Requests:** ~50 sessions × ~40 API calls = 2,000/day vs **100,000/day** → **2%** used.
- **Storage:** ~360k rows × ~200 B ≈ **70 MB/year** with indexes ≈ **150 MB/year** → 500 MB lasts **~3 years**, and we archive closed years to CSV + R2 at each year end. Effectively indefinite.

We are nowhere near any limit. The real constraints are the 10 ms CPU/request (reports) and 500 MB/database (solvable by year-end archiving).

---

## 10. Printing

Realistic scope, because this is where shop software usually disappoints:

| Output | Approach | Caveat |
|---|---|---|
| **A5 / A4 invoice** | Browser print + CSS `@page { size: A5 }` | Works on any printer/laptop. Also "Save as PDF" (free, and WhatsApp-shareable) |
| **80 mm thermal receipt** | Same, `@page { size: 80mm auto }` | Needs the thermal printer installed as an OS printer. Windows: vendor USB driver → fine. Android: needs **RawBT**-type bridge app, not pure browser |
| PDF for WhatsApp | Browser "Save as PDF" then share | No paid PDF library needed |

So: **laptop + USB/network printer = perfect. Phone + Bluetooth thermal = workable but needs a bridge app.** Decide which one is the counter reality before we design the bill screen.

---

## 11. Risks, honestly

| Risk | Likelihood | Mitigation |
|---|---|---|
| No internet at counter → can't bill | Medium | PWA caches last product/customer data; a **pending-bills queue** in IndexedDB that flushes on reconnect (v1.1). Bill on paper meanwhile; enter later. Note: queued bills create invoice-number gaps — number them at sync time |
| 10 ms CPU exceeded on heavy reports | Medium | Aggregation runs in SQL (CPU time in D1 is not the Worker's budget — to be verified); pre-aggregated daily summary table if needed; Year-end reports run at night |
| Free tier terms change under us | Medium | Portable SQL + nightly SQL dumps + CSV everywhere → worst case, migrate in a day |
| Single-region D1 latency (~50–150 ms from Pakistan) | Certain | Cloudflare edge is in Lahore/Karachi — API is fast; UI uses optimistic updates for the bill screen |
| Manager forgets password / loses device | Low | Recovery: a `wrangler` command resetting the hash (documented), plus the daily SQL file |
| Account locked out of GitHub (backups) | Low | R2 copy too; monthly downloaded copy on a phone/PC |
| Free tier silently stops after a policy change | Low | Backup job fails → GitHub emails you. That's your early-warning system |

---

## 12. Exit plan (so "free" never becomes a trap)

Every choice above is standard web tech. If the shop grows or free tiers collapse:

- **Data:** full `.sql` dump nightly + CSV per report. Nothing proprietary.
- **Port:** SQLite→Postgres is a day's work (Drizzle schema + a script); the React SPA and Hono API are untouched.
- **Host:** same app runs on a $5 VPS or Fly/Render paid tier. No Cloudflare-specific logic outside the D1 driver and R2 upload.

Cost of leaving: roughly one day, not one rewrite.

---

## 13. Decision points

1. **Stack:** Option A (Cloudflare, $0 with hard caps) vs B (Neon Postgres, nicer SQL, CU-hour risk) vs C (Supabase, faster build, pausing) vs D (Oracle VM, full control, more ops)?
2. **Counter hardware:** laptop + USB printer, or phone only? Decides whether thermal printing is print-critical in v1.
3. **Absolute-zero or "$5 escape hatch acceptable if we outgrow"?** Affects how much we optimise into the free caps.
4. **Domain:** `ihsancenter.workers.dev` (free) or a custom domain (~PKR 3,000/yr, needs a card)?

Next doc: `03-data-model.md` — tables, indexes, ledger strategy, and the exact statement list for every write.

---

### Sources checked (Oct/Nov 2026)
- Vercel fair use / Hobby non-commercial: vercel.com/docs/limits/fair-use-guidelines (via convika.com, sofast.host, temps.sh summaries)
- Cloudflare Workers limits: developers.cloudflare.com/workers/platform/limits
- Cloudflare D1 limits: developers.cloudflare.com/d1/platform/limits (500 MB/DB free, 5 GB total, 100k rows written/day)
- Supabase free tier: 500 MB, 2 projects, 1-week inactivity pause
- Neon free: 100 CU-hours/project, scale-to-zero at 5 min
- Render free: 15-min spin-down, Postgres expires at 30 days
