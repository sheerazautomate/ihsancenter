# Deployment guide — Cloudflare, $0

Everything here runs inside the free plan. No credit card is required for any step.

**Architecture in one sentence:** one Worker serves the built React app *and* the API,
backed by one D1 database. Single origin, so session cookies work with no CORS games.

```
https://ihsancenter-api.<your-subdomain>.workers.dev
   ├── /            → the React app (static assets, cached at the edge)
   ├── /receivables → index.html (SPA fallback, so bookmarks and refreshes work)
   └── /api/*       → Hono → D1
```

---

## 0. What you need first

| Thing | Why | Cost |
|---|---|---|
| Cloudflare account | hosts everything | free |
| Node 20+ locally | to run the deploy commands | — |
| `npx wrangler` | Cloudflare's CLI (installed with the repo) | — |
| GitHub account | optional, for CI deploys later | free |

Log in once:

```bash
npx wrangler login
```

A browser opens; approve it. This stores a token locally. You never paste a password
into a terminal.

---

## 1. Create the database

```bash
cd apps/api
npx wrangler d1 create ihsancenter
```

It prints something like:

```
✅ Successfully created DB 'ihsancenter'
database_id = "8f2c1a44-9b3e-4d21-8a77-0f5c2b1e9d10"
```

Copy that id into `apps/api/wrangler.toml`, replacing
`REPLACE_WITH_YOUR_DATABASE_ID`. **The deploy will fail without this** — it is the
single most common first-time error.

---

## 2. Apply the schema to the real database

The migrations are numbered and must run in order. Note `--remote`: without it you
are writing to the local simulator, not production.

```bash
npx wrangler d1 execute ihsancenter --remote --file=./migrations/0001_init.sql
npx wrangler d1 execute ihsancenter --remote --file=./migrations/0002_seed.sql
npx wrangler d1 execute ihsancenter --remote --file=./migrations/0003_auth_and_idempotency.sql
```

**Do NOT run `0004_demo_seed.sql`.** It inserts fake products, fake customers and a
fake opening balance. Those would be real rows in the shop's books.

Verify:

```bash
npx wrangler d1 execute ihsancenter --remote \
  --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
```

You should see all 20+ tables. If you only see `d1_migrations`, step 2 didn't run
against `--remote`.

---

## 3. Set the session secret

```bash
npx wrangler secret put SESSION_SECRET
```

Paste a long random value when prompted. Generate one:

```bash
openssl rand -base64 48
```

**Without this the API returns 500 on every login** — deliberately, so a
misconfigured deployment fails loudly instead of accepting sessions signed with an
empty key.

Changing this secret later logs everyone out (all cookies become invalid). That is
the correct behaviour, not a bug.

---

## 4. Build the frontend and deploy

The Worker serves `apps/web/dist`, so the build must happen **first**:

```bash
cd ../web && npm run build      # produces apps/web/dist
cd ../api && npx wrangler deploy
```

Success prints a URL:

```
https://ihsancenter-api.<your-subdomain>.workers.dev
```

Bookmark it. It is your shop's login page.

> **`dist` is git-ignored.** That is intentional — build artefacts don't belong in
> version control. It does mean the deployed app is whatever you last built locally.
> If you later add GitHub Actions, the build moves into CI and this stops mattering.

---

## 5. Create the manager account

There is no user until you do this. The endpoint works **once**, then refuses
forever, so it cannot be used later to add accounts.

```bash
curl -X POST https://ihsancenter-api.<your-subdomain>.workers.dev/api/auth/bootstrap \
  -H 'Content-Type: application/json' \
  -d '{"name":"Ihsan","username":"ihsan","password":"PUT-A-REAL-PASSWORD-HERE"}'
```

Then open the URL and sign in.

Use a real password here — this is not the `ihsan12345` demo credential. There is no
password reset by email; recovery is a direct database update (see §9).

---

## 6. Smoke test, in this order

Each of these catches a different class of problem:

| Check | Expected | If it fails |
|---|---|---|
| Open the URL | login screen | Worker/assets mismatch — rebuild and redeploy (§4) |
| Sign in | dashboard loads | `SESSION_SECRET` missing (§3) |
| Refresh the page on `/receivables` | still the app | SPA fallback broken — check `[assets]` in `wrangler.toml` |
| Create a product | appears in Stock | D1 binding wrong — check `database_id` (§1) |
| Ring a sale with cash | invoice prints | — |
| Ring a sale on credit over a limit | blocked with a reason | correct behaviour |
| Reports → Books check | "All documents balance" | something is genuinely wrong; do not enter real data |

That last one is the important gate: **the integrity check must pass before the shop
starts using it for real money.**

---

## 7. What you are (and aren't) getting on the free plan

Comfortably inside limits — measured, not guessed (`docs/plan/02-architecture.md`):

| Resource | Your peak | Free limit |
|---|---|---|
| Requests/day | ~2,000 | 100,000 |
| Rows written/day | ~1,600 | 100,000 |
| Storage | ~150 MB/year | 500 MB |

**Limits that do apply:**

- **No backups.** Free D1 has none. This is why I keep raising it — see §10.
- **10 ms CPU per request.** PBKDF2 is tuned to fit (25k iterations ≈ 4.4 ms).
  Heavy report exports may brush against it; if you see intermittent 500s on very
  large date ranges, that's why.
- **One region.** D1 picks a location; from Lahore expect ~50–150 ms per API call.
  Usable. Cloudflare's edge is in Karachi and Lahore, so static assets are fast.
- **No SLA.** It is a free tier; it will be up, but nothing is guaranteed.

**When you outgrow it** — one toggle, $5/month for Workers Paid, which removes the
request cap, the CPU cap, and lifts D1 to 10 GB. No rewrite.

---

## 8. Updating the app later

```bash
cd apps/web && npm run build
cd ../api && npx wrangler deploy
```

That's it — no downtime, no restart. Existing invoices are untouched; only code
changes. If you changed a migration, run it with `--remote` **before** deploying the
code that depends on it.

Rollback: `npx wrangler rollback` returns to the previous deployment instantly.

---

## 9. If the manager forgets the password

No reset email exists. Reset the hash directly:

```bash
# 1. Generate a hash with the same PBKDF2 the app uses
cd apps/api && npm run hash-password "the-new-password"
#    prints: <salt>:<hash> and the iteration count

# 2. Write it, and bump token_version to kill existing sessions
npx wrangler d1 execute ihsancenter --remote --command \
  "UPDATE users SET password_hash='<salt>:<hash>', iterations=25000,
   token_version=token_version+1 WHERE username='ihsan'"
```

(This helper script is a TODO — until it exists, the alternative is to delete the
user row and re-run the bootstrap endpoint, which also works and is simpler.)

---

## 10. Before real money goes in

Deployment is not the same as being ready. Still missing, in priority order:

1. **Backups.** You've deferred this, which is fine for testing — but free D1 has no
   backup at all, so today the books live on exactly one disk with no second copy.
   Set it up before the shop's first real invoice, not after. Plan is in
   `docs/plan/02-architecture.md` §6: nightly `d1 export` → R2 + a private repo.
2. **Opening balances screen.** Right now stock can be entered via a purchase, but a
   carry-forward customer balance needs direct SQL. Needed on day one of real use.
3. **Sale returns** — table and ledger are ready, only the endpoint and screen are
   missing.
4. **A second pair of eyes on the tax/rounding behaviour** with real supplier bills.

---

## 11. Optional: custom domain

The `workers.dev` URL is free and fine. A custom domain (e.g.
`accounts.ihsancenter.pk`) needs a domain purchase (~PKR 3,000/yr, requires a card)
and is free to attach to the Worker:

```bash
npx wrangler deploy --routes accounts.ihsancenter.pk
```

If you do this, add the new origin to `ALLOWED_ORIGINS` — though with the
single-origin setup CORS is not strictly needed, it keeps things sane if you ever
split the frontend off.
