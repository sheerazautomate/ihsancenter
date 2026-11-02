# Ihsan Center — Accounts & Inventory System
## Phase 1: Feature Set — v1.0 (LOCKED SCOPE)

**Business:** Pesticide / agri-input retail shop, single branch, currency **PKR**
**Primary user:** Manager / owner — **single login, no roles** in v1
**Companies (fixed):** Tahafuz · SunCrop · Engro · Syngenta
**Deployment:** Cloud web app (responsive — counter phone/tablet + office laptop)

### Decisions locked in this round
| Decision | Choice |
|---|---|
| Users & roles | Manager only, single account |
| Batches & expiry | **Deferred** — stock tracked as total qty per product |
| Tax / invoicing | **Plain cash memo**, no GST, no FBR |
| Hosting | Cloud web app, internet assumed at counter |
| Company payables | **Yes** — full purchase/payment/payable tracking |
| Opening data | Start fresh; manual opening stock + opening customer balances |

Legend: **[v1]** in this release · **[v1.1]** next · **[v2]** later

---

## 1. Master Data

### 1.1 Companies [v1]
Fixed 4 seeded: Tahafuz, SunCrop, Engro, Syngenta (editable name/contact).
Fields: name, contact person, phone, address, opening payable, notes.

### 1.2 Products [v1]
- name, **company**, category (insecticide / fungicide / herbicide / fertilizer / seed / other), unit & pack size (e.g. 250 ml, 1 kg), SKU/code, barcode (optional), **purchase rate, sale rate, reorder level**, active flag.
- One product belongs to exactly one company.
- Opening stock entry per product with cost (creates an "opening" stock movement).
- Bulk edit of sale rates (e.g. seasonal price update) [v1.1]

### 1.3 Customers [v1]
- name, phone, village/area, address, **credit limit**, opening balance, credit-hold flag, notes, active flag.
- Type: farmer / dealer / walk-in.
- Default "Walk-in Cash" customer for anonymous counter sales.
- Quick-add from sale screen (name + phone), full edit later.
- Customer ledger: every invoice, receipt, return, opening balance, running balance.

### 1.4 Shop settings [v1]
- Shop name, address, phone, logo, receipt footer text, invoice number prefix.
- Low-stock alert threshold default, stock-negative policy (allow/block, default block).

---

## 2. Purchases — Stock In

- **Purchase invoice** from a company: date, supplier invoice no., lines (product, qty, rate, discount), bill discount, freight, total.
- Posting **increases stock** and **increases payable** to that company.
- **Purchase return** to company (damaged / wrong item) → decreases stock, decreases payable. [v1]
- **Payment to company** (cash / bank / cheque no.) → decreases payable, posted to company ledger. [v1]
- Company ledger with running payable + aging (current / 30 / 60 / 90+). [v1]
- Purchase price history per product (last purchase rate shown on purchase screen). [v1.1]

---

## 3. Sales — the counter screen

### 3.1 New sale [v1]
- Fast search by product name / SKU / barcode; add line with qty, rate (auto-filled sale rate, editable), discount % or Rs.
- **Customer selection with live credit panel** — always visible:
  `Credit limit Rs 50,000 · Outstanding Rs 32,000 · Available Rs 18,000` + aging chip.
- **Split payment on one invoice:** cash + bank + credit ("udhaar") must equal total. Example: Rs 10,000 total → Rs 4,000 cash, Rs 6,000 credit.
- Bill-level discount, previous balance display, live change/remaining indicator.
- **Guards:** block if qty > stock (policy-driven); warn then block if credit limit would be exceeded (single manager can override with reason, logged).
- **Hold / resume bill**, **void bill with reason** (reverses stock + ledger, never deletes).
- Receipt printing: 80 mm thermal + A4 invoice, shop header/footer from settings.

### 3.2 Sale returns [v1]
- Return against an invoice, partial allowed; restocks product; refunds cash/bank **or** reduces customer credit balance.
- Return without invoice (walk-in with receipt torn) → manager-only, reason required.

### 3.3 Sales records [v1]
- Invoice list: search + filter by date range, customer, company, payment status (paid / partial / credit), cashier.
- Invoice detail with timeline (created, voided), print/reprint, void.

---

## 4. Inventory

- **Stock list:** product, company, category, qty on hand, cost value, retail value, status (ok / low / out).
- **Stock movement ledger** per product: opening, purchase, sale, sale return, purchase return, adjustment — with reference doc, date, in/out qty, running qty. Full traceability.
- **Manual adjustment** (damage, expiry write-off, count correction) with reason, manager-only.
- **Low stock / reorder list** with suggested qty (reorder level − on hand) and "last bought from" company.
- Stock valuation report (cost and retail side by side). [v1]
- Dead / slow-moving stock (no sale in 60/90 days). [v1.1]

---

## 5. Credit System (Receivables) — core requirement

- Credit limit + outstanding + available shown **at billing time**, before the sale is confirmed.
- **Aging buckets:** current, 1–30, 31–60, 61–90, 90+ days. [v1]
- **Per-invoice due date** and simple payment terms (e.g. 15 days from invoice). [v1]
- **Receive payment** from customer (cash / bank / cheque) → auto-allocated oldest-invoice-first, with manual override. [v1]
- **Credit hold** toggle per customer → blocks new credit sales until cleared. [v1]
- **Customer statement** print. [v1]
- Outstanding report sorted by amount + days overdue; one-tap WhatsApp reminder text. [v1.1]
- Cheque / post-dated cheque register. [v2]

---

## 6. Expenses

- Expense entry: date, category (rent, utilities, salaries, transport, tea/misc, repairs, license, other), amount, paid by (cash/bank), payee, note.
- Category management (add/edit categories).
- Expense list + monthly summary by category, month-over-month comparison. [v1]
- Recurring expense templates (rent, salary) that pre-fill on due date. [v1.1]

---

## 7. Cash & Bank

- **Cash book** auto-built from sales receipts, customer payments, company payments, expenses, adjustments. [v1]
- Bank accounts (name, number, opening balance) and postings. [v1]
- **Daily cash closing:** opening cash, in, out, expected closing vs entered counted cash, difference recorded. [v1]
- Owner drawings / capital in. [v1.1]

---

## 8. Dashboard & Reports

### 8.1 Dashboard [v1]
- Today: sales, cash collected, credit given, expenses.
- This month: sales, gross profit, expenses, **net profit**, receivables, payables, cash + bank balance.
- 30-day sales trend sparkline, top 5 products, top 5 debtors, low-stock and overdue-credit lists.
- **Company cards:** for each of the 4 — purchases, sales, gross margin, payable.

### 8.2 Reports [v1]
1. **Sales register** — daily / monthly / custom range, filterable.
2. **Company-wise summary** — purchases, sales, margin, payable for all 4 (the "totals of all companies" ask).
3. **Product-wise sales & profit** — qty, revenue, COGS, margin.
4. **Customer outstanding + aging.**
5. **Company payables + aging.**
6. **Expense summary** by category/period.
7. **Profit & Loss (simple):** sales − COGS − expenses = net profit for any period.
8. **Stock valuation & movement.**
9. **Cash book & bank book.**
10. **Day book** — every transaction of a date in chronological order.
11. All reports printable + CSV export [v1], PDF export [v1.1].

### 8.3 Reports [v1.1]
Customer profitability, area/village-wise sales, seasonal YoY comparison, discount leakage, returns analysis, dead stock.

---

## 9. Platform & Non-functional

- Web app, mobile-first responsive; works on a Rs 15k Android phone at the counter.
- Currency formatting `Rs 1,234,567` (Western grouping); `Rs 1,23,456` lassi grouping only if you insist.
- Bilingual labels English + Urdu toggle. [v1.1]
- **Nothing is ever hard-deleted** — void/cancel with reason and audit stamp (created/updated time on every record).
- **Automatic daily database backup** (cloud) + manual download of full backup. [v1]
- Session timeout / password change; single account with strong password. [v1]
- Fast: invoice list and search respond < 300 ms at 50k invoices.

---

## 10. Explicitly out of scope for v1
Batches/expiry tracking · multi-branch · user roles/permissions · GST/FBR e-invoicing · online storefront · native mobile app · SMS gateway · offline-first sync · route salesman app · consignment stock · barcode label printing · customer mobile app.

---

## 11. Suggested build order (for the architect phase)
1. Foundation: companies, products, customers, settings, opening balances.
2. Purchases + company payables + company ledger.
3. **Sales + credit panel + split payment + returns** (the money path).
4. Stock ledger & adjustments, low stock.
5. Customer receipts, aging, statements.
6. Expenses + cash/bank + daily closing.
7. Dashboard + the 11 reports.
8. Backup, print polish, seed data for the 4 companies.
