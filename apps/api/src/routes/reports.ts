import { Hono } from 'hono';
import { requireAuth, type AppEnv } from '../middleware';
import { businessDate } from '../lib/numbering';
import { INVOICE_BALANCE_SQL } from '../lib/ledger';
import {
  cashPositionSql,
  companyTotalsSql,
  dailySummarySql,
  expenseSummarySql,
  payableAgingSql,
  productSalesSql,
  profitAndLossSql,
  receivableAgingSql,
} from '../lib/reports';

export const reportRoutes = new Hono<AppEnv>();

reportRoutes.use('*', requireAuth);

const monthStart = (d: string) => `${d.slice(0, 7)}-01`;

function range(c: { req: { query: (k: string) => string | undefined } }) {
  const today = businessDate();
  const from = c.req.query('from') ?? monthStart(today);
  const to = c.req.query('to') ?? today;
  return { from, to };
}

/** Dashboard: today plus month-to-date plus the two balances that matter most. */
reportRoutes.get('/dashboard', async (c) => {
  const today = businessDate();
  const from = monthStart(today);

  const [todayRow, monthRow, pnlRow, cash, companies, receivable, lowStock] = await Promise.all([
    c.env.DB.prepare(dailySummarySql())
      .bind(today, today, today, today, today, today)
      .first(),
    c.env.DB.prepare(dailySummarySql())
      .bind(from, from, from, from, from, from)
      .first(),
    c.env.DB.prepare(profitAndLossSql()).bind(from, today).first<{
      revenuePaisa: number;
      cogsPaisa: number;
      expensesPaisa: number;
    }>(),
    c.env.DB.prepare(cashPositionSql()).all(),
    c.env.DB.prepare(companyTotalsSql()).bind(from, today, from, today).all(),
    c.env.DB.prepare(
      `SELECT COALESCE(SUM(debit_paisa - credit_paisa), 0) AS total
       FROM ledger_entries WHERE account_type = 'customer'`,
    ).first<{ total: number }>(),
    c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM products
       WHERE is_active = 1 AND qty_on_hand_milli <= reorder_level_milli`,
    ).first<{ n: number }>(),
  ]);

  const pnl = pnlRow ?? { revenuePaisa: 0, cogsPaisa: 0, expensesPaisa: 0 };
  const grossProfit = pnl.revenuePaisa - pnl.cogsPaisa;
  const netProfit = grossProfit - pnl.expensesPaisa;
  const totalReceivable = receivable?.total ?? 0;

  return c.json({
    date: today,
    today: todayRow,
    month: monthRow,
    monthFrom: from,
    profit: {
      revenuePaisa: pnl.revenuePaisa,
      cogsPaisa: pnl.cogsPaisa,
      grossProfitPaisa: grossProfit,
      expensesPaisa: pnl.expensesPaisa,
      netProfitPaisa: netProfit,
    },
    cash: cash.results,
    companies: companies.results,
    totalReceivablePaisa: totalReceivable,
    lowStockCount: lowStock?.n ?? 0,
  });
});

reportRoutes.get('/companies', async (c) => {
  const { from, to } = range(c);
  const rows = await c.env.DB.prepare(companyTotalsSql()).bind(from, from, from, to).all();
  return c.json({ from, to, companies: rows.results });
});

reportRoutes.get('/profit-loss', async (c) => {
  const { from, to } = range(c);
  const row = await c.env.DB.prepare(profitAndLossSql()).bind(from, to).first<{
    revenuePaisa: number;
    cogsPaisa: number;
    expensesPaisa: number;
    discountsPaisa: number;
  }>();
  const r = row ?? { revenuePaisa: 0, cogsPaisa: 0, expensesPaisa: 0, discountsPaisa: 0 };
  return c.json({
    from,
    to,
    ...r,
    grossProfitPaisa: r.revenuePaisa - r.cogsPaisa,
    netProfitPaisa: r.revenuePaisa - r.cogsPaisa - r.expensesPaisa,
  });
});

reportRoutes.get('/receivables', async (c) => {
  const rows = await c.env.DB.prepare(receivableAgingSql(INVOICE_BALANCE_SQL)).all();
  return c.json({ customers: rows.results });
});

reportRoutes.get('/payables', async (c) => {
  const rows = await c.env.DB.prepare(payableAgingSql()).all();
  return c.json({ companies: rows.results });
});

reportRoutes.get('/products', async (c) => {
  const { from, to } = range(c);
  const rows = await c.env.DB.prepare(productSalesSql()).bind(from, to).all();
  return c.json({ from, to, products: rows.results });
});

reportRoutes.get('/expenses', async (c) => {
  const { from, to } = range(c);
  const rows = await c.env.DB.prepare(expenseSummarySql()).bind(from, to).all();
  return c.json({ from, to, categories: rows.results });
});

reportRoutes.get('/cash', async (c) => {
  const rows = await c.env.DB.prepare(cashPositionSql()).all();
  return c.json({ accounts: rows.results });
});

/**
 * Self-check: proves the books actually balance.
 *
 * Two independent assertions:
 *   1. every document's ledger entries sum to zero
 *   2. cached stock equals the sum of its movements
 *
 * If either returns rows, something is wrong and the operator needs to know
 * before the accountant does.
 */
reportRoutes.get('/integrity', async (c) => {
  const unbalanced = await c.env.DB.prepare(
    `SELECT doc_type, doc_id, SUM(debit_paisa) AS dr, SUM(credit_paisa) AS cr
     FROM ledger_entries GROUP BY doc_type, doc_id
     HAVING dr <> cr LIMIT 50`,
  ).all();

  const stockDrift = await c.env.DB.prepare(
    `SELECT p.id, p.name, p.qty_on_hand_milli AS cached,
            COALESCE(SUM(m.qty_change_milli), 0) AS fromMovements
     FROM products p LEFT JOIN stock_movements m ON m.product_id = p.id
     GROUP BY p.id
     HAVING cached <> fromMovements LIMIT 50`,
  ).all();

  const orphanLedger = await c.env.DB.prepare(
    `SELECT account_type, COUNT(*) AS n FROM ledger_entries
     WHERE account_type IN ('customer','supplier','cash') AND account_id IS NULL
     GROUP BY account_type`,
  ).all();

  const ok =
    (unbalanced.results?.length ?? 0) === 0 &&
    (stockDrift.results?.length ?? 0) === 0 &&
    (orphanLedger.results?.length ?? 0) === 0;

  return c.json({
    ok,
    unbalancedDocuments: unbalanced.results ?? [],
    stockDrift: stockDrift.results ?? [],
    accountsMissingId: orphanLedger.results ?? [],
    checkedAt: new Date().toISOString(),
  });
});
