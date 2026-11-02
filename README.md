# Ihsan Center

Accounts, inventory and credit system for a pesticide retail shop (PKR).

## Planning
- [Phase 1 — Feature set (locked scope)](docs/plan/01-feature-set.md)
- [Phase 2 — Architecture & free-tier strategy](docs/plan/02-architecture.md)
- [Phase 2b — GitHub Pages + Google Sheets evaluation](docs/plan/03-github-pages-and-google-sheets.md)
- [Phase 3 — Data model](docs/plan/04-data-model.md)
- [Build notes — verified findings](docs/plan/05-build-notes-verified.md)

## Code
- `apps/api` — Hono API on Cloudflare Workers + D1 (schema, ledger, sales, tests)
- 39 tests passing against real D1: `npm test`
