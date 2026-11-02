import { Hono } from 'hono';
import { requireAuth, type AppEnv } from '../middleware';
import { REPORTS, findReport, type ReportDef } from '../lib/reports-catalog';
import { buildCsv, buildXls, buildXlsx, type Cell, type SheetSpec } from '../lib/xls';
import { businessDate } from '../lib/numbering';

export const exportRoutes = new Hono<AppEnv>();

exportRoutes.use('*', requireAuth);

/**
 * A hard ceiling on rows per export.
 *
 * Not a technical limit -- a phone will happily build 20,000 rows in a few
 * hundred milliseconds -- but a runaway export on the free plan burns CPU the
 * shop has only 10 ms of per request. At this size the workbook stays under a
 * megabyte, which is what WhatsApp and email will actually carry.
 */
const MAX_ROWS = 20000;

/** Which id a scoped report needs, and where it comes from. */
function scopeId(def: ReportDef, c: { req: { query: (k: string) => string | undefined } }): string | null {
  if (def.scope === 'customer') return c.req.query('customerId') ?? null;
  if (def.scope === 'company') return c.req.query('companyId') ?? null;
  return null;
}

interface RunResult {
  columns: string[];
  rows: Cell[][];
  truncated: boolean;
}

async function runReport(
  db: D1Database,
  def: ReportDef,
  params: string[] = [],
  limit = MAX_ROWS,
): Promise<RunResult> {
  const sql = `SELECT * FROM (${def.sql}) LIMIT ${limit + 1}`;
  const stmt = db.prepare(sql);
  const bound = params.length > 0 ? stmt.bind(...params) : stmt;
  const result = await bound.all<Record<string, unknown>>();

  const raw = result.results ?? [];
  const truncated = raw.length > limit;
  const rows = raw.slice(0, limit).map((row) => {
    // Take values by the query's own key order, which is the column order the
    // report declares. Object key order from D1 follows the SELECT list.
    return def.columns.map((_, i) => {
      const value = Object.values(row)[i];
      if (value === null || value === undefined) return null;
      return typeof value === 'number' ? value : String(value);
    });
  });

  return { columns: def.columns, rows, truncated };
}

/** Excel caps sheet names at 31 characters; these stay readable within that. */
function shortName(def: ReportDef): string {
  return SHEET_NAMES[def.slug] ?? def.title.slice(0, 31);
}

const SHEET_NAMES: Record<string, string> = {
  customers: 'Customers',
  'sale-returns': 'Sale returns',
  companies: 'Companies',
  'purchase-returns': 'Purchase returns',
  'stock-in': 'Stock in',
  'stock-out': 'Stock out',
  'stock-movements': 'Stock movements',
  'stock-current': 'Stock on hand',
  'cash-flow': 'Cash flow',
  accounts: 'Cash & bank accounts',
  expenses: 'Expenses',
  'all-sales': 'All sales',
  'all-purchases': 'All purchases',
  'all-payments': 'Payments to companies',
  ledger: 'Full ledger',
  audit: 'Activity log',
};

/** A file name a shopkeeper can recognise in a downloads folder. */
function fileName(def: ReportDef, ext: string, scopeName?: string): string {
  const stamp = businessDate();
  const parts = ['ihsan', def.slug];
  if (scopeName) parts.push(scopeName.replace(/[^a-zA-Z0-9]+/g, '-').slice(0, 40));
  parts.push(stamp);
  return `${parts.join('_')}.${ext}`;
}

function attachment(c: { header: (k: string, v: string) => void }, name: string, type: string) {
  c.header('Content-Type', type);
  c.header('Content-Disposition', `attachment; filename="${name}"`);
  // Exports are per-request and must never be cached by the browser or a proxy.
  c.header('Cache-Control', 'no-store');
}

/**
 * The catalogue, for the UI to render the list.
 *
 * Driven from the server so a report added here appears on the screen with no
 * front-end change -- and so the two can never disagree about what exists.
 */
exportRoutes.get('/', (c) => {
  return c.json({
    reports: REPORTS.map((r) => ({
      slug: r.slug,
      title: r.title,
      description: r.description,
      group: r.group,
      scope: r.scope ?? null,
      columns: r.columns.length,
    })),
  });
});

/**
 * One report as a file.
 *
 *   GET /api/reports/export/customer-history?customerId=cust_ali&format=xlsx
 *
 * `format` is xlsx (default, SpreadsheetML), csv, or tsv (paste straight into a
 * spreadsheet). CSV is the escape hatch for very large exports.
 */
exportRoutes.get('/:slug', async (c) => {
  const def = findReport(c.req.param('slug'));
  if (!def) return c.json({ error: 'No such report' }, 404);

  const scope = scopeId(def, c);
  if (def.scope && !scope) {
    return c.json({ error: `${def.title} needs a ${def.scope === 'customer' ? 'customerId' : 'companyId'}` }, 400);
  }

  const format = (c.req.query('format') ?? 'xlsx').toLowerCase();
  if (!['xlsx', 'xls', 'csv', 'tsv'].includes(format)) {
    return c.json({ error: 'format must be xlsx, xls, csv or tsv' }, 400);
  }

  let scopeName: string | undefined;
  if (scope) {
    const table = def.scope === 'customer' ? 'customers' : 'companies';
    const row = await c.env.DB.prepare(`SELECT name FROM ${table} WHERE id = ?`)
      .bind(scope)
      .first<{ name: string }>();
    if (!row) return c.json({ error: 'Not found' }, 404);
    scopeName = row.name;
  }

  const { columns, rows, truncated } = await runReport(
    c.env.DB,
    def,
    scope ? [scope] : [],
  );

  if (format === 'csv' || format === 'tsv') {
    const text = format === 'csv' ? buildCsv(columns, rows) : buildCsv(columns, rows).replace(/,/g, '\t');
    attachment(c, fileName(def, format === 'tsv' ? 'tsv' : 'csv', scopeName), 'text/plain; charset=utf-8');
    if (truncated) c.header('X-Export-Truncated', `true`);
    return c.body(text);
  }

  const sheet: SheetSpec = {
    name: shortName(def),
    columns,
    widths: def.widths,
    rows,
    moneyColumns: def.moneyColumns,
  };

  if (truncated) c.header('X-Export-Truncated', 'true');

  // .xls is the SpreadsheetML fallback; .xlsx is what phones and Google Sheets
  // open, and is the default.
  if (format === 'xls') {
    attachment(c, fileName(def, 'xls', scopeName), 'application/vnd.ms-excel');
    return c.body(buildXls([sheet], def.title));
  }

  attachment(
    c,
    fileName(def, 'xlsx', scopeName),
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  // ArrayBuffer, not Uint8Array: Hono's body types only accept binary as a buffer.
  const xlsx = buildXlsx([sheet], def.title);
  return c.body(xlsx.buffer.slice(xlsx.byteOffset, xlsx.byteOffset + xlsx.byteLength) as ArrayBuffer);
});

/**
 * Everything, in one workbook: one sheet per report plus a cover sheet that says
 * what each sheet answers and what the numbers were at the moment of export.
 *
 * This is the "single click" the shop asked for. It is also the closest thing to
 * a backup that exists -- which is worth knowing, because the free plan has none.
 */
exportRoutes.get('/everything/all', async (c) => {
  const db = c.env.DB;
  const sheets: SheetSpec[] = [];
  const failed: string[] = [];

  // Per-customer and per-supplier history would produce one sheet per person and
  // blow past Excel's practical limits. In this workbook those are summarised;
  // the individual histories are one click away on each customer's page.
  const [customers, companies] = await Promise.all([
    db.prepare(`SELECT id, name FROM customers ORDER BY name`).all<{ id: string; name: string }>(),
    db.prepare(`SELECT id, name FROM companies ORDER BY name`).all<{ id: string; name: string }>(),
  ]);

  for (const def of REPORTS) {
    if (def.scope) continue; // handled per-entity below
    try {
      const { columns, rows } = await runReport(db, def, [], 5000);
      sheets.push({
        // Short, listed names rather than a slice of the title: "Cash flow — every
        // rupee in and" is what cutting at Excel's 31-character limit produces.
        name: shortName(def),
        columns,
        widths: def.widths,
        rows,
        moneyColumns: def.moneyColumns,
      });
    } catch (err) {
      // One broken report must not cost the shop the whole export.
      failed.push(`${def.title}: ${err instanceof Error ? err.message : 'failed'}`);
    }
  }

  // One sheet per customer with history, so the workbook genuinely contains every
  // customer's whole story, not just a summary.
  const perCustomer: SheetSpec[] = [];
  for (const cust of customers.results ?? []) {
    const def = findReport('customer-history')!;
    try {
      const { columns, rows } = await runReport(db, def, [cust.id], 2000);
      if (rows.length === 0) continue;
      perCustomer.push({
        name: `${cust.name}`.slice(0, 31),
        columns,
        widths: def.widths,
        moneyColumns: def.moneyColumns,
        rows,
      });
    } catch {
      failed.push(`customer ${cust.name}`);
    }
  }

  for (const comp of companies.results ?? []) {
    const def = findReport('company-history')!;
    try {
      const { columns, rows } = await runReport(db, def, [comp.id], 2000);
      if (rows.length === 0) continue;
      perCustomer.push({
        name: `C-${comp.name}`.slice(0, 31),
        columns,
        widths: def.widths,
        moneyColumns: def.moneyColumns,
        rows,
      });
    } catch {
      failed.push(`company ${comp.name}`);
    }
  }

  const cover: SheetSpec = {
    name: 'Contents',
    columns: ['Sheet', 'What it answers', 'Rows'],
    widths: [180, 420, 70],
    rows: [
      ['Ihsan Center — full export', `Generated ${new Date().toISOString()}`, null],
      ['', '', null],
      ...sheets.map((s) => [s.name, REPORTS.find((r) => shortName(r) === s.name)?.description ?? '', s.rows.length]),
      ['', '', null],
      ['Per-customer history', `One sheet per customer with any movement (${perCustomer.length} sheets)`, null],
      ['Per-company history', 'Sheets beginning "C-" — every supplier movement', null],
      ...(failed.length > 0 ? [['', '', null], ['INCOMPLETE', `These could not be exported: ${failed.join('; ')}`, null]] : []),
    ],
  };

  const bytes = buildXlsx([cover, ...sheets, ...perCustomer], 'Ihsan Center — full export');
  attachment(
    c,
    `ihsan_everything_${businessDate()}.xlsx`,
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  return c.body(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
});
