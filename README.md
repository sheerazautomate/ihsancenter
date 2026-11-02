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
- `apps/web` — React SPA: billing, invoices, purchases, udhaar, customers, stock, expenses, reports, opening balances, dashboard
- 100 tests (95 API against real D1, 5 web): `npm test`

## First run on a fresh database

`npm run dev` gives you demo data, but a real shop starts here:

1. Sign in, add the products and customers you sell to.
2. Open **Opening** and enter what already exists — customers' khata balances,
   what each company is owed, cash in the drawer and bank, and stock on the shelf.
   The screen shows the resulting owner's capital before you post it.
3. From then on, use sales, purchases and receipts. Each account can be opened
   only once; anything entered there is locked.

## Run it locally
```bash
npm install
npm run dev        # resets local DB, starts API :8787 and web :5173
```
Then sign in as `manager` / `ihsan12345`. See `scripts/README.md`.
