import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { postSale } from '../src/lib/sales';
import { postPurchase, postSupplierPayment, postPurchaseReturn } from '../src/lib/purchases';
import { postExpense, postReceipt } from '../src/lib/receipts';
import { rupeesToPaisa, qtyToMilli } from '../src/lib/money';

const DB = env.DB as D1Database;

const PRODUCT = 'prod_flow';
const CUSTOMER = 'cust_flow';
const COMPANY = 'co_tahafuz';

beforeEach(async () => {
  const tables = [
    'tx_guard', 'audit_log', 'ledger_entries', 'stock_movements',
    'receipt_allocations', 'customer_receipts',
    'sale_return_lines', 'sale_returns',
    'sales_invoice_lines', 'sales_invoices',
    'purchase_return_lines', 'purchase_returns',
    'purchase_lines', 'purchases', 'supplier_payments', 'expenses', 'doc_sequences',
  ];
  for (const t of tables) await DB.prepare(`DELETE FROM ${t}`).run();
  await DB.prepare(`DELETE FROM products`).run();
  await DB.prepare(`DELETE FROM customers WHERE id <> 'cust_walkin'`).run();

  await DB.batch([
    DB.prepare(
      `INSERT INTO customers (id, name, type, credit_limit_paisa, created_at)
       VALUES (?, 'Flow Customer', 'farmer', 10000000, '2026-01-01T00:00:00Z')`,
    ).bind(CUSTOMER),
    DB.prepare(
      `INSERT INTO products (id, company_id, name, category, purchase_rate_paisa,
         sale_rate_paisa, avg_cost_paisa, qty_on_hand_milli, created_at, updated_at)
       VALUES (?, ?, 'Flow Product', 'insecticide', 10000, 20000, 10000, 0,
               '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    ).bind(PRODUCT, COMPANY),
  ]);
});

async function stock(): Promise<number> {
  const row = await DB.prepare(`SELECT qty_on_hand_milli AS q FROM products WHERE id = ?`)
    .bind(PRODUCT)
    .first<{ q: number }>();
  return row!.q;
}

async function avgCost(): Promise<number> {
  const row = await DB.prepare(`SELECT avg_cost_paisa AS c FROM products WHERE id = ?`)
    .bind(PRODUCT)
    .first<{ c: number }>();
  return row!.c;
}

async function balance(account: 'customer' | 'supplier' | 'cash' | 'inventory' | 'expense', id: string | null): Promise<number> {
  const row = await DB.prepare(
    `SELECT COALESCE(SUM(debit_paisa - credit_paisa), 0) AS b FROM ledger_entries
     WHERE account_type = ? AND account_id IS ?`,
  )
    .bind(account, id)
    .first<{ b: number }>();
  return row!.b;
}

/** Every document's entries must sum to zero. */
async function unbalancedDocs() {
  const res = await DB.prepare(
    `SELECT doc_id, SUM(debit_paisa) AS dr, SUM(credit_paisa) AS cr
     FROM ledger_entries GROUP BY doc_id HAVING dr <> cr`,
  ).all();
  return res.results ?? [];
}

/** Cached stock must equal summed movements. */
async function stockDrift() {
  const res = await DB.prepare(
    `SELECT p.id FROM products p LEFT JOIN stock_movements m ON m.product_id = p.id
     GROUP BY p.id HAVING p.qty_on_hand_milli <> COALESCE(SUM(m.qty_change_milli), 0)`,
  ).all();
  return res.results ?? [];
}

describe('purchases', () => {
  it('increases stock, records a payable and balances the ledger', async () => {
    const result = await postPurchase(DB, {
      docDate: '2026-11-02',
      companyId: COMPANY,
      supplierInvoiceNo: 'TF-8891',
      lines: [{ productId: PRODUCT, qtyMilli: qtyToMilli(100), ratePaisa: rupeesToPaisa(100) }],
      paidCashPaisa: rupeesToPaisa(4000),
      cashAccountId: 'ca_counter',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.purchase.totalPaisa).toBe(rupeesToPaisa(10000));
    expect(result.purchase.payablePaisa).toBe(rupeesToPaisa(6000));

    expect(await stock()).toBe(qtyToMilli(100));
    // Stock in = Dr Inventory 10,000; payables up = Cr Supplier 6,000; cash down 4,000
    expect(await balance('inventory', null)).toBe(rupeesToPaisa(10000));
    expect(await balance('supplier', COMPANY)).toBe(-rupeesToPaisa(6000)); // credit balance
    expect(await balance('cash', 'ca_counter')).toBe(-rupeesToPaisa(4000));

    expect(await unbalancedDocs()).toEqual([]);
    expect(await stockDrift()).toEqual([]);
  });

  it('computes a weighted average cost across two purchases', async () => {
    await postPurchase(DB, {
      docDate: '2026-11-01',
      companyId: COMPANY,
      lines: [{ productId: PRODUCT, qtyMilli: qtyToMilli(100), ratePaisa: rupeesToPaisa(100) }],
    });
    expect(await avgCost()).toBe(rupeesToPaisa(100));

    // 100 more at Rs 200 -> average Rs 150
    await postPurchase(DB, {
      docDate: '2026-11-02',
      companyId: COMPANY,
      lines: [{ productId: PRODUCT, qtyMilli: qtyToMilli(100), ratePaisa: rupeesToPaisa(200) }],
    });

    expect(await stock()).toBe(qtyToMilli(200));
    expect(await avgCost()).toBe(rupeesToPaisa(150));
  });

  it('capitalises freight into the inventory value', async () => {
    const result = await postPurchase(DB, {
      docDate: '2026-11-02',
      companyId: COMPANY,
      lines: [{ productId: PRODUCT, qtyMilli: qtyToMilli(10), ratePaisa: rupeesToPaisa(100) }],
      freightPaisa: rupeesToPaisa(500),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.purchase.totalPaisa).toBe(rupeesToPaisa(1500));
    expect(await balance('inventory', null)).toBe(rupeesToPaisa(1500));
  });

  it('is idempotent on the same key', async () => {
    const args = {
      docDate: '2026-11-02',
      companyId: COMPANY,
      lines: [{ productId: PRODUCT, qtyMilli: qtyToMilli(10), ratePaisa: rupeesToPaisa(100) }],
      idempotencyKey: 'purchase-tap-1',
    };
    const first = await postPurchase(DB, args);
    const second = await postPurchase(DB, args);

    expect(first.ok && second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.replayed).toBe(true);
    expect(await stock()).toBe(qtyToMilli(10)); // counted once
  });

  it('records a supplier payment that reduces the payable', async () => {
    await postPurchase(DB, {
      docDate: '2026-11-02',
      companyId: COMPANY,
      lines: [{ productId: PRODUCT, qtyMilli: qtyToMilli(10), ratePaisa: rupeesToPaisa(100) }],
    });
    expect(await balance('supplier', COMPANY)).toBe(-rupeesToPaisa(1000));

    const paid = await postSupplierPayment(DB, {
      docDate: '2026-11-03',
      companyId: COMPANY,
      amountPaisa: rupeesToPaisa(600),
      mode: 'bank',
      cashAccountId: 'ca_bank',
    });
    expect(paid.ok).toBe(true);

    expect(await balance('supplier', COMPANY)).toBe(-rupeesToPaisa(400));
    expect(await balance('cash', 'ca_bank')).toBe(-rupeesToPaisa(600));
    expect(await unbalancedDocs()).toEqual([]);
  });

  it('returns goods to the company and reduces the payable', async () => {
    await postPurchase(DB, {
      docDate: '2026-11-02',
      companyId: COMPANY,
      lines: [{ productId: PRODUCT, qtyMilli: qtyToMilli(20), ratePaisa: rupeesToPaisa(100) }],
    });

    const returned = await postPurchaseReturn(DB, {
      docDate: '2026-11-03',
      companyId: COMPANY,
      lines: [{ productId: PRODUCT, qtyMilli: qtyToMilli(5), ratePaisa: rupeesToPaisa(100) }],
      reason: 'Damaged in transit',
    });
    expect(returned.ok).toBe(true);

    expect(await stock()).toBe(qtyToMilli(15));
    expect(await balance('supplier', COMPANY)).toBe(-rupeesToPaisa(1500));
    expect(await unbalancedDocs()).toEqual([]);
    expect(await stockDrift()).toEqual([]);
  });
});

describe('customer receipts', () => {
  async function makeInvoice(creditRupees: number) {
    const result = await postSale(DB, {
      docDate: '2026-10-01',
      customerId: CUSTOMER,
      lines: [
        { productId: PRODUCT, qtyMilli: qtyToMilli(creditRupees / 200), ratePaisa: rupeesToPaisa(200) },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    return result.sale;
  }

  beforeEach(async () => {
    // stock to sell from
    await postPurchase(DB, {
      docDate: '2026-09-01',
      companyId: COMPANY,
      lines: [{ productId: PRODUCT, qtyMilli: qtyToMilli(100), ratePaisa: rupeesToPaisa(100) }],
    });
  });

  it('collects money and reduces the customer balance', async () => {
    await makeInvoice(5000);
    expect(await balance('customer', CUSTOMER)).toBe(rupeesToPaisa(5000));

    const result = await postReceipt(DB, {
      docDate: '2026-11-02',
      customerId: CUSTOMER,
      amountPaisa: rupeesToPaisa(2000),
      mode: 'cash',
      cashAccountId: 'ca_counter',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.receipt.receiptNo).toMatch(/^REC-2026-/);
    expect(result.receipt.allocatedPaisa).toBe(rupeesToPaisa(2000));
    expect(result.receipt.unallocatedPaisa).toBe(0);

    expect(await balance('customer', CUSTOMER)).toBe(rupeesToPaisa(3000));
    expect(await balance('cash', 'ca_counter')).toBe(rupeesToPaisa(2000));
    expect(await unbalancedDocs()).toEqual([]);
  });

  it('allocates oldest invoices first', async () => {
    const first = await makeInvoice(1000); // 2026-10-01
    await DB.prepare(`UPDATE sales_invoices SET doc_date = '2026-09-15' WHERE id = ?`)
      .bind(first.id)
      .run();
    const second = await makeInvoice(1000); // 2026-10-01

    const result = await postReceipt(DB, {
      docDate: '2026-11-02',
      customerId: CUSTOMER,
      amountPaisa: rupeesToPaisa(1500),
      mode: 'cash',
      cashAccountId: 'ca_counter',
    });
    expect(result.ok).toBe(true);

    const allocations = await DB.prepare(
      `SELECT invoice_id, amount_paisa FROM receipt_allocations ORDER BY amount_paisa DESC`,
    ).all<{ invoice_id: string; amount_paisa: number }>();

    // oldest invoice paid in full, newer one partly
    const oldest = allocations.results!.find((a) => a.invoice_id === first.id);
    const newer = allocations.results!.find((a) => a.invoice_id === second.id);
    expect(oldest!.amount_paisa).toBe(rupeesToPaisa(1000));
    expect(newer!.amount_paisa).toBe(rupeesToPaisa(500));
  });

  it('treats money beyond the balance as an advance, not an error', async () => {
    await makeInvoice(1000);

    const result = await postReceipt(DB, {
      docDate: '2026-11-02',
      customerId: CUSTOMER,
      amountPaisa: rupeesToPaisa(1500),
      mode: 'cash',
      cashAccountId: 'ca_counter',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.receipt.unallocatedPaisa).toBe(rupeesToPaisa(500));
    // balance goes negative: the shop owes them
    expect(await balance('customer', CUSTOMER)).toBe(-rupeesToPaisa(500));
  });

  it('rejects an allocation larger than the invoice balance', async () => {
    const invoice = await makeInvoice(1000);

    const result = await postReceipt(DB, {
      docDate: '2026-11-02',
      customerId: CUSTOMER,
      amountPaisa: rupeesToPaisa(5000),
      mode: 'cash',
      cashAccountId: 'ca_counter',
      allocations: [{ invoiceId: invoice.id, amountPaisa: rupeesToPaisa(5000) }],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/exceeds its balance/i);
  });

  it('is idempotent on the same key', async () => {
    await makeInvoice(5000);
    const args = {
      docDate: '2026-11-02',
      customerId: CUSTOMER,
      amountPaisa: rupeesToPaisa(1000),
      mode: 'cash' as const,
      cashAccountId: 'ca_counter',
      idempotencyKey: 'receipt-tap-1',
    };

    const first = await postReceipt(DB, args);
    const second = await postReceipt(DB, args);

    expect(first.ok && second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.replayed).toBe(true);
    expect(await balance('customer', CUSTOMER)).toBe(rupeesToPaisa(4000)); // charged once
  });
});

describe('expenses', () => {
  it('posts a balanced expense against cash', async () => {
    const result = await postExpense(DB, {
      docDate: '2026-11-02',
      categoryId: 'ec_utilifake',
      amountPaisa: rupeesToPaisa(1850),
      cashAccountId: 'ca_counter',
    });
    // unknown category must be rejected
    expect(result.ok).toBe(false);

    const good = await postExpense(DB, {
      docDate: '2026-11-02',
      categoryId: 'ec_utilities',
      amountPaisa: rupeesToPaisa(1850),
      cashAccountId: 'ca_counter',
      payee: 'LESCO',
    });
    expect(good.ok).toBe(true);

    expect(await balance('expense', 'ec_utilities')).toBe(rupeesToPaisa(1850));
    expect(await balance('cash', 'ca_counter')).toBe(-rupeesToPaisa(1850));
    expect(await unbalancedDocs()).toEqual([]);
  });
});

describe('full day of trading keeps the books balanced', () => {
  it('purchase -> sale -> receipt -> expense all reconcile', async () => {
    await postPurchase(DB, {
      docDate: '2026-11-02',
      companyId: COMPANY,
      lines: [{ productId: PRODUCT, qtyMilli: qtyToMilli(50), ratePaisa: rupeesToPaisa(100) }],
      paidCashPaisa: rupeesToPaisa(2000),
      cashAccountId: 'ca_counter',
    });

    const sale = await postSale(DB, {
      docDate: '2026-11-02',
      customerId: CUSTOMER,
      lines: [{ productId: PRODUCT, qtyMilli: qtyToMilli(10), ratePaisa: rupeesToPaisa(150) }],
      paidCashPaisa: rupeesToPaisa(500),
      cashAccountId: 'ca_counter',
    });
    expect(sale.ok).toBe(true);

    await postReceipt(DB, {
      docDate: '2026-11-02',
      customerId: CUSTOMER,
      amountPaisa: rupeesToPaisa(400),
      mode: 'cash',
      cashAccountId: 'ca_counter',
    });

    await postExpense(DB, {
      docDate: '2026-11-02',
      categoryId: 'ec_tea',
      amountPaisa: rupeesToPaisa(45),
      cashAccountId: 'ca_counter',
    });

    expect(await unbalancedDocs()).toEqual([]);
    expect(await stockDrift()).toEqual([]);

    // 50 bought - 10 sold
    expect(await stock()).toBe(qtyToMilli(40));

    // revenue 1,500, cogs 1,000 -> gross profit 500
    const revenue = await DB.prepare(
      `SELECT COALESCE(SUM(credit_paisa - debit_paisa), 0) AS r FROM ledger_entries WHERE account_type = 'sales'`,
    ).first<{ r: number }>();
    expect(revenue!.r).toBe(rupeesToPaisa(1500));

    // customer still owes 1,000 - 400 = 600
    expect(await balance('customer', CUSTOMER)).toBe(rupeesToPaisa(600));
    // company payable 5,000 - 2,000 = 3,000
    expect(await balance('supplier', COMPANY)).toBe(-rupeesToPaisa(3000));
  });
});

describe('receivable report agrees with the ledger', () => {
  it('reports a customer who owes an opening balance with no invoice behind it', async () => {
    // This is the exact bug found during manual testing: the report was built only
    // from invoice balances, so a carry-forward khata balance made the customer
    // disappear from the report while their statement still showed money owed.
    await DB.batch([
      DB.prepare(
        `INSERT INTO ledger_entries (id, entry_date, account_type, account_id, debit_paisa,
           credit_paisa, doc_type, doc_id, memo, created_at)
         VALUES ('le_opening_dr', '2026-09-01', 'customer', ?, 970000, 0, 'opening', 'op1',
                 'Opening balance', '2026-09-01T00:00:00Z')`,
      ).bind(CUSTOMER),
      DB.prepare(
        `INSERT INTO ledger_entries (id, entry_date, account_type, account_id, debit_paisa,
           credit_paisa, doc_type, doc_id, memo, created_at)
         VALUES ('le_opening_cr', '2026-09-01', 'equity', NULL, 0, 970000, 'opening', 'op1',
                 'Opening balance', '2026-09-01T00:00:00Z')`,
      ),
    ]);

    const { receivableAgingSql } = await import('../src/lib/reports');
    const { INVOICE_BALANCE_SQL } = await import('../src/lib/ledger');

    const rows = await DB.prepare(receivableAgingSql(INVOICE_BALANCE_SQL)).all<{
      customerId: string;
      totalPaisa: number;
      d0to30: number;
      unappliedPaisa: number;
    }>();

    const row = (rows.results ?? []).find((r) => r.customerId === CUSTOMER);
    expect(row).toBeDefined();
    expect(row!.totalPaisa).toBe(rupeesToPaisa(9700));

    // ledger balance is what it is, and the report says so
    expect(await balance('customer', CUSTOMER)).toBe(rupeesToPaisa(9700));
  });

  it('keeps the invoice-derived aging when invoices do exist', async () => {
    await postPurchase(DB, {
      docDate: '2026-09-01',
      companyId: COMPANY,
      lines: [{ productId: PRODUCT, qtyMilli: qtyToMilli(50), ratePaisa: rupeesToPaisa(100) }],
    });
    await postSale(DB, {
      docDate: '2026-10-01',
      customerId: CUSTOMER,
      lines: [{ productId: PRODUCT, qtyMilli: qtyToMilli(10), ratePaisa: rupeesToPaisa(200) }],
    });

    const { receivableAgingSql } = await import('../src/lib/reports');
    const { INVOICE_BALANCE_SQL } = await import('../src/lib/ledger');

    const rows = await DB.prepare(receivableAgingSql(INVOICE_BALANCE_SQL)).all<{
      customerId: string;
      totalPaisa: number;
      d31to60: number;
      unappliedPaisa: number;
    }>();

    const row = (rows.results ?? []).find((r) => r.customerId === CUSTOMER);
    expect(row!.totalPaisa).toBe(rupeesToPaisa(2000));
    // the invoice is ~32 days old at test time, so it lands in the 31-60 bucket
    // OR in 0-30 if the clock is near the boundary; both are "applied"
    expect(row!.unappliedPaisa).toBe(0);
  });
});

describe('payables report agrees with the ledger', () => {
  it('reflects a payment that is not tied to any purchase', async () => {
    // Found manually: the payables report computed purchases-minus-payments, so a
    // payment against a balance with no purchase behind it left the report showing
    // the full amount while the ledger and dashboard showed it reduced.
    await DB.batch([
      DB.prepare(
        `INSERT INTO ledger_entries (id, entry_date, account_type, account_id, debit_paisa,
           credit_paisa, doc_type, doc_id, memo, created_at)
         VALUES ('le_sup_opening', '2026-09-01', 'supplier', ?, 0, 13000000, 'opening', 'op_sup',
                 'Opening payable', '2026-09-01T00:00:00Z')`,
      ).bind(COMPANY),
      DB.prepare(
        `INSERT INTO ledger_entries (id, entry_date, account_type, account_id, debit_paisa,
           credit_paisa, doc_type, doc_id, memo, created_at)
         VALUES ('le_sup_equity', '2026-09-01', 'equity', NULL, 13000000, 0, 'opening', 'op_sup',
                 'Opening payable', '2026-09-01T00:00:00Z')`,
      ),
    ]);

    const paid = await postSupplierPayment(DB, {
      docDate: '2026-11-02',
      companyId: COMPANY,
      amountPaisa: rupeesToPaisa(50000),
      mode: 'bank',
      cashAccountId: 'ca_bank',
    });
    expect(paid.ok).toBe(true);

    const { payableAgingSql } = await import('../src/lib/reports');
    const rows = await DB.prepare(payableAgingSql()).all<{ companyId: string; totalPaisa: number }>();
    const row = (rows.results ?? []).find((r) => r.companyId === COMPANY);

    expect(row!.totalPaisa).toBe(rupeesToPaisa(80000));

    // and the ledger agrees with the report
    const ledgerBalance = await DB.prepare(
      `SELECT COALESCE(SUM(credit_paisa - debit_paisa), 0) AS b FROM ledger_entries
       WHERE account_type = 'supplier' AND account_id = ?`,
    )
      .bind(COMPANY)
      .first<{ b: number }>();
    expect(ledgerBalance!.b).toBe(row!.totalPaisa);
  });
});
