# Local development

```bash
npm install
npm run db:reset:local     # schema + seed + demo data
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

- `apps/api` — Hono on Cloudflare Workers, D1. Tests: `npm test` (39 tests).
- `apps/web` — React + Vite SPA, proxying `/api` to the Worker in dev.

## Demo data

`migrations/0004_demo_seed.sql` creates 4 customers, 9 products across all four
companies, opening stock, one opening credit balance and two expenses.

**Never apply 0004 to production** — it would put fake stock and fake customer
balances into real books. Production runs 0001–0003 only.
