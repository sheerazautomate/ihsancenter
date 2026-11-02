# Local development

```bash
npm install
npm run db:reset:local     # schema + seed + demo data (refuses if the API is running)
npm run dev                # db reset, then API (:8787) + web (:5173)
```

Open http://localhost:5173 and sign in.

**First-time only** — create the manager account (there is no user until you do):

```bash
curl -X POST http://localhost:8787/api/auth/bootstrap \
  -H 'Content-Type: application/json' \
  -d '{"name":"Manager","username":"manager","password":"choose-a-strong-one"}'
```

The bootstrap endpoint refuses to run once any user exists, so it cannot be used
to add accounts later.

## Layout

- `apps/api` — Hono on Cloudflare Workers, D1. Tests: `npm test` (133 API tests).
- `apps/web` — React SPA. 5 unit tests for the API URL helper.
- `apps/web` — React + Vite SPA, proxying `/api` to the Worker in dev.

## Demo data

`apps/api/demo/demo_seed.sql` creates 4 customers, 9 products across all four
companies, opening stock, one opening credit balance and two expenses.

It sits **outside `migrations/`** on purpose. Anything in that directory risks being
applied to production by a wildcard, and fake customers, fake stock and fake balances
cannot be deleted cleanly once they are posted to real books.

Never apply it to production: fake stock and fake customer balances would become real
rows in the shop's books. Production runs `migrations/` only — `0001`–`0003`.

Sign in with `manager` / `ihsan12345` on the local dev database.

## Benchmarks

```bash
npm run bench --workspace @ihsan/api    # PBKDF2 timing in the real Workers runtime
```

## Resetting the database

`npm run db:reset:local` deletes `.wrangler/state/v3/d1` and re-applies the schema.
It **refuses to run while the dev server is up** — deleting the SQLite file out from
under a running Worker makes every query fail with `SQLITE_CANTOPEN`, which surfaces
as a 500 on login and looks exactly like a missing `SESSION_SECRET`. Stop the server
first, or use `npm run dev`, which resets before starting anything.

A fresh database has no user. Create one with the bootstrap call above.

## Deployment

See [`docs/plan/06-deployment.md`](../docs/plan/06-deployment.md). The three helpers:

```bash
npm run deploy:build      # build the SPA into apps/web/dist
npm run deploy:check      # preflight; blocks the silent deploy failures
node scripts/smoke.mjs https://your-worker.workers.dev --user ihsan --password '...'
node scripts/hash-password.mjs 'new-password'    # password recovery
```
