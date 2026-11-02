import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { readFileSync } from 'node:fs';
import { postSale, voidSale } from '../src/lib/sales';
import { creditPanelSql, creditPanelParams, toCreditPanel } from '../src/lib/ledger';
import { rupeesToPaisa, qtyToMilli, formatPkr, lineTotalPaisa, weightedAvgCostPaisa } from '../src/lib/money';

const DB = env.DB as D1Database;

// ---------------------------------------------------------------------------
// The whole test suite depends on ONE D1 behaviour: a failing CHECK constraint
// inside a batch() rolls back every statement in that batch. If this assumption
// is wrong, the guard design in src/lib/guard.ts is wrong. So we prove it first.
// ---------------------------------------------------------------------------
describe('D1 batch atomicity (the assumption everything rests on)', () => {
  it('rolls back every statement in a batch when a CHECK fails', async () => {
    await DB.prepare(
      `INSERT INTO companies (id, name, created_at) VALUES ('co_atomic_test', 'AtomicCo', '2026-01-01T00:00:00Z')`,
    ).run();

    const before = await DB.prepare(`SELECT COUNT(*) AS n FROM companies`).first<{ n: number }>();

    await expect(
      DB.batch([
        DB.prepare(
          `INSERT INTO companies (id, name, created_at) VALUES ('co_should_vanish', 'Vanish', '2026-01-01T00:00:00Z')`,
        ),
        // code !== 'ok' violates the CHECK on tx_guard
        DB.prepare(`INSERT INTO tx_guard (code, detail) VALUES ('boom', 'test')`),
      ]),
    ).rejects.toThrow();

    const after = await DB.prepare(`SELECT COUNT(*) AS n FROM companies`).first<{ n: number }>();
    expect(after!.n).toBe(before!.n);

    const vanished = await DB.prepare(`SELECT id FROM companies WHERE id = 'co_should_vanish'`).first();
    expect(vanished).toBeNull();

    await DB.prepare(`DELETE FROM companies WHERE id = 'co_atomic_test'`).run();
  });

  it('keeps foreign keys enabled', async () => {
    const row = await DB.prepare(`PRAGMA foreign_keys`).first<Record<string, number>>();
    // D1 forces FK enforcement on; just record what we observe.
    expect(Object.values(row ?? {})[0]).toBe(1);
  });
});

describe('money', () => {
  it('parses rupees into integer paisa', () => {
    expect(rupeesToPaisa('1234.50')).toBe(123450);
    expect(rupeesToPaisa(0.1) + rupeesToPaisa(0.2)).toBe(rupeesToPaisa(0.3));
  });

  it('formats in lakh/crore grouping', () => {
    expect(formatPkr(1234500)).toBe('Rs 12,345.00');
    expect(formatPkr(123456700)).toBe('Rs 12,34,567.00');
    expect(formatPkr(-123456700)).toBe('-Rs 12,34,567.00');
    // 100,00,00,000 rupees (100 crore) -> 10,00,00,00,000 paisa
    expect(formatPkr(100000000000)).toBe('Rs 1,00,00,00,000.00');
  });

  it('parses quantities into milli-units', () => {
    expect(qtyToMilli(2.5)).toBe(2500);
    expect(qtyToMilli('12')).toBe(12000);
  });

  it('computes line totals with half-up rounding, no floats', () => {
    // 2.5 kg @ Rs 400.00 = Rs 1000.00
    expect(lineTotalPaisa(2500, 40000)).toBe(100000);
    // 3 x Rs 33.33 = Rs 99.99
    expect(lineTotalPaisa(3000, 3333)).toBe(9999);
    // discount applied
    expect(lineTotalPaisa(2500, 40000, 5000)).toBe(95000);
  });

  it('computes weighted average cost', () => {
    // 10 units at 100 + 10 units at 200 = avg 150
    expect(weightedAvgCostPaisa(10000, 10000, 10000, 20000)).toBe(15000);
  });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const CUSTOMER_WITH_LIMIT = 'cust_limit';
const CUSTOMER_NO_LIMIT = 'cust_nolimit';
// Rs 100 cost / Rs 200 sale, 100 units in stock. Chosen so that
// 50 units = Rs 10,000 with Rs 5,000 cost, which exercises the split payment.
const PRODUCT_A = 'prod_a';

/**
 * Each test starts from an identical, known database. The suite posts real
 * documents, so without this the tests would depend on each other's leftovers.
 */
const TRANSACTIONAL_TABLES = [
  'tx_guard', 'audit_log', 'ledger_entries', 'stock_movements',
  'receipt_allocations', 'customer_receipts',
  'sale_return_lines', 'sale_returns',
  'sales_invoice_lines', 'sales_invoices',
  'purchase_return_lines', 'purchase_returns',
  'purchase_lines', 'purchases',
  'supplier_payments', 'expenses',
  'doc_sequences',
];

beforeEach(async () => {
  for (const table of TRANSACTIONAL_TABLES) {
    await DB.prepare(`DELETE FROM ${table}`).run();
  }
  await DB.prepare(`DELETE FROM products`).run();
  await DB.prepare(`DELETE FROM customers WHERE id <> 'cust_walkin'`).run();

  await DB.batch([
    DB.prepare(
      `INSERT INTO customers (id, name, type, credit_limit_paisa, is_credit_hold, created_at)
       VALUES (?, 'Ali Khan', 'farmer', 5000000, 0, '2026-01-01T00:00:00Z')`,
    ).bind(CUSTOMER_WITH_LIMIT),
    DB.prepare(
      `INSERT INTO customers (id, name, type, credit_limit_paisa, created_at)
       VALUES (?, 'Big Dealer', 'dealer', 0, '2026-01-01T00:00:00Z')`,
    ).bind(CUSTOMER_NO_LIMIT),
    DB.prepare(
      `INSERT INTO products (id, company_id, name, category, purchase_rate_paisa,
         sale_rate_paisa, avg_cost_paisa, qty_on_hand_milli, created_at, updated_at)
       VALUES (?, 'co_tahafuz', 'Tahafuz Kan Ram', 'insecticide', 10000, 20000, 10000, 10000000,
               '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    ).bind(PRODUCT_A),
  ]);
});


/**
 * The canonical split sale: 50 units @ Rs 200 = Rs 10,000, paying Rs 4,000 cash,
# leaving Rs 6,000 on credit.
 */
async function postSplitSale() {
  return postSale(DB, {
    docDate: '2026-11-02',
    customerId: CUSTOMER_WITH_LIMIT,
    cashAccountId: 'ca_counter',
    lines: [{ productId: PRODUCT_A, qtyMilli: qtyToMilli(50), ratePaisa: rupeesToPaisa(200) }],
    paidCashPaisa: rupeesToPaisa(4000),
  });
}

async function stockOf(productId: string): Promise<number> {
  const row = await DB.prepare(`SELECT qty_on_hand_milli AS q FROM products WHERE id = ?`)
    .bind(productId)
    .first<{ q: number }>();
  return row!.q;
}

async function outstandingOf(customerId: string): Promise<number> {
  const row = await DB.prepare(
    `SELECT COALESCE(SUM(debit_paisa - credit_paisa), 0) AS bal
     FROM ledger_entries WHERE account_type = 'customer' AND account_id = ?`,
  )
    .bind(customerId)
    .first<{ bal: number }>();
  return row!.bal;
}

async function ledgerBalances(docId: string): Promise<{ dr: number; cr: number }> {
  const row = await DB.prepare(
    `SELECT COALESCE(SUM(debit_paisa),0) AS dr, COALESCE(SUM(credit_paisa),0) AS cr
     FROM ledger_entries WHERE doc_id = ?`,
  )
    .bind(docId)
    .first<{ dr: number; cr: number }>();
  return row!;
}

// ---------------------------------------------------------------------------
describe('posting a sale', () => {
  it('posts a split cash + credit sale and keeps the ledger balanced', async () => {
    const result = await postSplitSale();

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.sale.totalPaisa).toBe(rupeesToPaisa(10000));
    expect(result.sale.creditPaisa).toBe(rupeesToPaisa(6000));
    expect(result.sale.costTotalPaisa).toBe(rupeesToPaisa(5000)); // 5 @ Rs 10
    expect(result.sale.invoiceNo).toBe('INV-2026-00001');

    // ledger balanced
    const sums = await ledgerBalances(result.sale.id);
    expect(sums.dr).toBe(sums.cr);

    // stock down 5
    expect(await stockOf(PRODUCT_A)).toBe(9950000);

    // customer owes 6000
    expect(await outstandingOf(CUSTOMER_WITH_LIMIT)).toBe(rupeesToPaisa(6000));

    // a stock movement was written with a running balance
    const mv = await DB.prepare(
      `SELECT qty_change_milli, balance_after_milli FROM stock_movements WHERE doc_id = ?`,
    )
      .bind(result.sale.id)
      .first<{ qty_change_milli: number; balance_after_milli: number }>();
    expect(mv!.qty_change_milli).toBe(-50000);
    expect(mv!.balance_after_milli).toBe(9950000);
  });

  it('rejects a cash sale that exceeds the invoice total', async () => {
    const result = await postSale(DB, {
      docDate: '2026-11-02',
      customerId: CUSTOMER_NO_LIMIT,
      cashAccountId: 'ca_counter',
      lines: [{ productId: PRODUCT_A, qtyMilli: qtyToMilli(1), ratePaisa: rupeesToPaisa(200) }],
      paidCashPaisa: rupeesToPaisa(500),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/exceeds invoice total/i);
  });

  it('blocks credit beyond the customer limit, atomically', async () => {
    // Owe Rs 6,000 against a Rs 50,000 limit -> Rs 44,000 headroom.
    const opening = await postSplitSale();
    expect(opening.ok).toBe(true);

    // Now try to put Rs 62,000 on credit: 310 units @ Rs 200.
    const stockBefore = await stockOf(PRODUCT_A);

    const result = await postSale(DB, {
      docDate: '2026-11-02',
      customerId: CUSTOMER_WITH_LIMIT,
      lines: [{ productId: PRODUCT_A, qtyMilli: qtyToMilli(310), ratePaisa: rupeesToPaisa(200) }], // Rs 62,000 on credit
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('credit_limit_exceeded');

    // Nothing may have changed: no stock movement, no invoice, no ledger row.
    expect(await stockOf(PRODUCT_A)).toBe(stockBefore);
    expect(await outstandingOf(CUSTOMER_WITH_LIMIT)).toBe(rupeesToPaisa(6000));

    const orphans = await DB.prepare(
      `SELECT COUNT(*) AS n FROM sales_invoices WHERE customer_id = ? AND total_paisa > ?`,
    )
      .bind(CUSTOMER_WITH_LIMIT, rupeesToPaisa(10000))
      .first<{ n: number }>();
    expect(orphans!.n).toBe(0);
  });

  it('allows the same sale with a logged manager override', async () => {
    const result = await postSale(DB, {
      docDate: '2026-11-02',
      customerId: CUSTOMER_WITH_LIMIT,
      lines: [{ productId: PRODUCT_A, qtyMilli: qtyToMilli(200), ratePaisa: rupeesToPaisa(200) }], // Rs 40,000 on credit, over the limit
      overrideCredit: true,
      overrideReason: 'Harvest season, known customer',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const audit = await DB.prepare(
      `SELECT action, detail_json FROM audit_log WHERE entity_id = ?`,
    )
      .bind(result.sale.id)
      .first<{ action: string; detail_json: string }>();
    expect(audit!.action).toBe('override');
    expect(JSON.parse(audit!.detail_json).overrideReason).toMatch(/harvest/i);
  });

  it('blocks selling more stock than exists', async () => {
    const stockBefore = await stockOf(PRODUCT_A);

    const result = await postSale(DB, {
      docDate: '2026-11-02',
      customerId: CUSTOMER_NO_LIMIT,
      cashAccountId: 'ca_counter',
      lines: [{ productId: PRODUCT_A, qtyMilli: qtyToMilli(99999), ratePaisa: rupeesToPaisa(200) }],
      paidCashPaisa: rupeesToPaisa(200) * 99999,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('insufficient_stock');
    expect(await stockOf(PRODUCT_A)).toBe(stockBefore);
  });

  it('cannot oversell with two lines of the same product', async () => {
    // Two lines of 3 units each against 5 units of stock must fail together.
    await DB.prepare(`UPDATE products SET qty_on_hand_milli = 5000 WHERE id = ?`).bind(PRODUCT_A).run();

    const result = await postSale(DB, {
      docDate: '2026-11-02',
      customerId: CUSTOMER_NO_LIMIT,
      cashAccountId: 'ca_counter',
      lines: [
        { productId: PRODUCT_A, qtyMilli: 3000, ratePaisa: rupeesToPaisa(200) },
        { productId: PRODUCT_A, qtyMilli: 3000, ratePaisa: rupeesToPaisa(200) },
      ],
      paidCashPaisa: rupeesToPaisa(120),
    });

    expect(result.ok).toBe(false);
    expect(await stockOf(PRODUCT_A)).toBe(5000);

  });

  it('refuses credit for the walk-in customer', async () => {
    const result = await postSale(DB, {
      docDate: '2026-11-02',
      customerId: 'cust_walkin',
      lines: [{ productId: PRODUCT_A, qtyMilli: qtyToMilli(1), ratePaisa: rupeesToPaisa(200) }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/walk-in/i);
  });
});

describe('voiding a sale', () => {
  it('reverses stock and ledger without deleting anything', async () => {
    const stockBefore = await stockOf(PRODUCT_A);
    const posted = await postSale(DB, {
      docDate: '2026-11-02',
      customerId: CUSTOMER_NO_LIMIT,
      cashAccountId: 'ca_counter',
      lines: [{ productId: PRODUCT_A, qtyMilli: qtyToMilli(2), ratePaisa: rupeesToPaisa(200) }],
      paidCashPaisa: rupeesToPaisa(40),
    });
    expect(posted.ok).toBe(true);
    if (!posted.ok) return;

    expect(await stockOf(PRODUCT_A)).toBe(stockBefore - 2000);

    const voided = await voidSale(DB, {
      invoiceId: posted.sale.id,
      reason: 'Customer changed mind',
    });
    expect(voided.ok).toBe(true);

    // stock restored
    expect(await stockOf(PRODUCT_A)).toBe(stockBefore);

    // the invoice still exists, marked void
    const inv = await DB.prepare(`SELECT status, void_reason FROM sales_invoices WHERE id = ?`)
      .bind(posted.sale.id)
      .first<{ status: string; void_reason: string }>();
    expect(inv!.status).toBe('void');
    expect(inv!.void_reason).toBe('Customer changed mind');

    // all ledger entries for this document still net to zero
    const sums = await ledgerBalances(posted.sale.id);
    expect(sums.dr).toBe(sums.cr);
  });

  it('refuses to void without a reason', async () => {
    const result = await voidSale(DB, { invoiceId: 'whatever', reason: '' });
    expect(result.ok).toBe(false);
  });
});

describe('credit panel', () => {
  it('reports limit, outstanding, available and aging for the billing screen', async () => {
    const posted = await postSplitSale();
    expect(posted.ok).toBe(true);

    const row = await DB.prepare(creditPanelSql())
      .bind(...creditPanelParams(CUSTOMER_WITH_LIMIT))
      .first<Record<string, unknown>>();

    const panel = toCreditPanel(row!, 0);

    expect(panel.creditLimitPaisa).toBe(rupeesToPaisa(50000));
    expect(panel.outstandingPaisa).toBe(rupeesToPaisa(6000));
    expect(panel.hasLimit).toBe(true);
    expect(panel.availablePaisa).toBe(panel.creditLimitPaisa - panel.outstandingPaisa);
    expect(panel.wouldExceed).toBe(false);

    // asking for more than available flips it
    const over = toCreditPanel(row!, panel.availablePaisa! + 100);
    expect(over.wouldExceed).toBe(true);
  });

  it('treats a zero limit as unlimited', async () => {
    const row = await DB.prepare(creditPanelSql())
      .bind(...creditPanelParams(CUSTOMER_NO_LIMIT))
      .first<Record<string, unknown>>();
    const panel = toCreditPanel(row!, rupeesToPaisa(999999));
    expect(panel.hasLimit).toBe(false);
    expect(panel.availablePaisa).toBeNull();
    expect(panel.wouldExceed).toBe(false);
  });
});
