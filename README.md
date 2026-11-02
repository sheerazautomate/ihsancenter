# Ihsan Center

Accounts, inventory and credit system for a pesticide retail shop (PKR).

## Planning
- [Phase 1 — Feature set (locked scope)](docs/plan/01-feature-set.md)
- [Phase 2 — Architecture & free-tier strategy](docs/plan/02-architecture.md)
- [Phase 2b — GitHub Pages + Google Sheets evaluation](docs/plan/03-github-pages-and-google-sheets.md)
- [Phase 3 — Data model](docs/plan/04-data-model.md)
- [Build notes — verified findings](docs/plan/05-build-notes-verified.md)
- [Deployment guide](docs/plan/06-deployment.md)

## Code
- `apps/api` — Hono API on Cloudflare Workers + D1 (schema, ledger, sales, auth)
- `apps/web` — React SPA: billing, invoices, purchases, udhaar, stock, expenses, reports, dashboard
- 66 tests passing against real D1: `npm test`

## Run it locally
```bash
npm install
npm run dev        # resets local DB, starts API :8787 and web :5173
```
Then sign in as `manager` / `ihsan12345`. See `scripts/README.md`.
