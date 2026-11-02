import { describe, it, expect, beforeAll } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { createUser } from '../src/lib/auth';
import { buildCsv, buildXls } from '../src/lib/xls';

const DB = env.DB as D1Database;
let cookie = '';

async function post(path: string, body: unknown) {
  return SELF.fetch(`https://api.test${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify(body),
  });
}

function get(path: string) {
  return SELF.fetch(`https://api.test${path}`, { headers: { Cookie: cookie } });
}

/** Pull the data rows out of a SpreadsheetML file without an XML library. */
function sheetRows(xml: string): string[][] {
  const rows: string[][] = [];
  for (const rowMatch of xml.matchAll(/<Row[^>]*>(.*?)<\/Row>/g)) {
    const cells: string[] = [];
    for (const cellMatch of rowMatch[1].matchAll(/<Data[^>]*>(.*?)<\/Data>/g)) {
      cells.push(
        cellMatch[1]
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&amp;/g, '&'),
      );
    }
    rows.push(cells);
  }
  return rows;
}

beforeAll(async () => {
  await DB.prepare(`DELETE FROM users WHERE username = 'exportuser'`).run();
  await createUser(DB, { name: 'Export Tester', username: 'exportuser', password: 'export-pass-1' });

  const res = await SELF.fetch('https://api.test/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'exportuser', password: 'export-pass-1' }),
  });
  cookie = res.headers.get('Set-Cookie')!.split(';')[0];

  // Something real for the reports to find.
  const cust = await post('/api/customers', { name: 'Export Farmer', phone: '03005554444', village: 'Layyah' });
  expect(cust.status).toBe(201);

  const company = await post('/api/catalog/companies', { name: 'Export Supplier' });
  const companyId = (await company.json<{ id: string }>()).id;
  const product = await post('/api/catalog/products', {
    name: 'Export Product',
    companyId,
    category: 'other',
    purchaseRate: 100,
    saleRate: 200,
  });
  const productId = (await product.json<{ id: string }>()).id;

  const purchase = await post('/api/purchases', {
    companyId,
    lines: [{ productId, qty: 50, rate: 100 }],
    paidCash: 0,
    cashAccountId: 'ca_counter',
  });
  expect(purchase.status).toBe(201);

  const sale = await post('/api/sales', {
    customerId: (await cust.json<{ id: string }>()).id,
    lines: [{ productId, qty: 5, rate: 200 }],
    paidCash: 400,
    cashAccountId: 'ca_counter',
  });
  expect(sale.status).toBe(201);
});

describe('the export catalogue', () => {
  it('lists every log, grouped and searchable by the UI', async () => {
    const res = await get('/api/reports/export');
    expect(res.status).toBe(200);
    const body = await res.json<{ reports: { slug: string; group: string; scope: string | null }[] }>();

    // The shop asked for "each and every possible log"; these are the ones that
    // must never disappear silently.
    const slugs = body.reports.map((r) => r.slug);
    for (const required of [
      'customers',
      'customer-history',
      'customer-invoices',
      'customer-items',
      'customer-receipts',
      'companies',
      'company-history',
      'company-purchases',
      'company-payments',
      'stock-in',
      'stock-out',
      'stock-movements',
      'stock-current',
      'cash-flow',
      'expenses',
      'all-sales',
      'all-purchases',
      'ledger',
      'audit',
    ]) {
      expect(slugs, `missing report: ${required}`).toContain(required);
    }

    const groups = new Set(body.reports.map((r) => r.group));
    expect(groups.has('Customers')).toBe(true);
    expect(groups.has('Stock')).toBe(true);
  });

  it('404s an unknown slug rather than returning an empty file', async () => {
    expect((await get('/api/reports/export/not-a-report')).status).toBe(404);
  });
});

describe('exporting a report', () => {
  it('returns a real xlsx by default, with rupee amounts not paisa', async () => {
    const res = await get('/api/reports/export/customers');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(res.headers.get('Content-Disposition')).toContain('.xlsx');

    // A real xlsx is a ZIP: it must start with PK\x03\x04, not with '<?xml'.
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes[0]).toBe(0x50); // P
    expect(bytes[1]).toBe(0x4b); // K
    expect(bytes[2]).toBe(0x03);
    expect(bytes[3]).toBe(0x04);

    // And the parts a spreadsheet app insists on must all be present.
    const text = new TextDecoder().decode(bytes);
    for (const part of [
      '[Content_Types].xml',
      'xl/workbook.xml',
      'xl/styles.xml',
      'xl/worksheets/sheet1.xml',
    ]) {
      expect(text, `missing ${part}`).toContain(part);
    }
  });

  it('still serves the SpreadsheetML .xls when asked for it', async () => {
    const res = await get('/api/reports/export/customers?format=xls');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('ms-excel');

    const xml = await res.text();
    expect(xml).toContain('<?mso-application progid="Excel.Sheet"?>');
    const rows = sheetRows(xml);
    expect(rows[0]).toContain('Name');
  });

  it('answers a customer history as a running ledger', async () => {
    const list = await (await get('/api/customers?limit=100')).json<{
      customers: { id: string; name: string }[];
    }>();
    const farmer = list.customers.find((c) => c.name === 'Export Farmer')!;

    const res = await get(`/api/reports/export/customer-history?customerId=${farmer.id}&format=xls`);
    expect(res.status).toBe(200);

    const rows = sheetRows(await res.text());
    expect(rows[0]).toEqual(['Date', 'Document', 'Type', 'Detail', 'Debit (Rs)', 'Credit (Rs)', 'Balance (Rs)']);

    // A credit sale of 1000 less 400 cash leaves 600 owed, and the running
    // balance column must say so -- that is the number a farmer disputes.
    const last = rows[rows.length - 1];
    expect(last[6]).toBe('600');
  });

  it('requires the id that a scoped report is scoped to', async () => {
    const res = await get('/api/reports/export/customer-history');
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toMatch(/needs a customerId/i);

    expect((await get('/api/reports/export/company-history')).status).toBe(400);
  });

  it('404s a scoped report for somebody who does not exist', async () => {
    expect((await get('/api/reports/export/customer-history?customerId=cust_nope')).status).toBe(404);
  });

  it('exports CSV with a BOM so Excel reads the names correctly', async () => {
    const res = await get('/api/reports/export/customers?format=csv');
    expect(res.status).toBe(200);

    const text = await res.text();
    expect(text.charCodeAt(0)).toBe(0xfeff); // byte order mark
    const lines = text.replace(/^\ufeff/, '').split('\r\n');
    expect(lines[0]).toContain('Name');
    expect(lines.some((l) => l.startsWith('Export Farmer'))).toBe(true);
  });

  it('separates stock in from stock out, and both carry the document', async () => {
    const inbound = sheetRows(await (await get('/api/reports/export/stock-in?format=xls')).text());
    const outbound = sheetRows(await (await get('/api/reports/export/stock-out?format=xls')).text());

    expect(inbound[0]).toContain('Qty in');
    expect(outbound[0]).toContain('Qty out');

    // The purchase brought 50 in; the sale took 5 out.
    expect(inbound.some((r) => r[1] === 'Export Product' && r[4] === '50')).toBe(true);
    expect(outbound.some((r) => r[1] === 'Export Product' && r[4] === '5')).toBe(true);

    // Every movement must name the document that caused it, or the log is
    // untraceable back to an invoice.
    const saleRow = outbound.find((r) => r[1] === 'Export Product' && r[4] === '5')!;
    expect(saleRow[7]).toMatch(/^sale inv_/);
  });

  it('rejects an unsupported format instead of silently sending Excel', async () => {
    expect((await get('/api/reports/export/customers?format=pdf')).status).toBe(400);
  });
});

describe('the everything workbook', () => {
  it('contains a sheet per log plus a contents page', async () => {
    const res = await get('/api/reports/export/everything/all');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition')).toContain('.xlsx');

    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);

    // Sheet names live in xl/workbook.xml inside the zip. Stored (uncompressed)
    // entries mean the XML is readable straight out of the byte stream.
    const xml = new TextDecoder().decode(bytes);
    const names = [...xml.matchAll(/<sheet name="([^"]+)"/g)].map((m) => m[1]);

    expect(names).toContain('Contents');
    expect(names).toContain('Customers');
    expect(names).toContain('Stock in');
    expect(names).toContain('Cash flow');
    expect(names).toContain('Full ledger');

    // Every customer with movement gets their own sheet, named after them.
    expect(names).toContain('Export Farmer');

    // Contents must list what is inside, or the file is a pile of tabs.
    expect(xml).toContain('What it answers');
  });
});

describe('the excel and csv writers', () => {
  it('survives characters that would otherwise corrupt the file', () => {
    // A control character or a raw & in a notes field used to be able to make
    // Excel refuse the entire download.
    const xml = buildXls(
      [{ name: 'Tricky', columns: ['A', 'B'], rows: [['Tom & Jerry', 'tab\there'], ['<script>', null]] }],
      'Tricky <title>',
    );
    expect(xml).toContain('Tom &amp; Jerry');
    expect(xml).toContain('&lt;script&gt;');
    expect(xml).not.toContain('<script>');
  });

  it('quotes CSV fields containing commas, quotes and newlines', () => {
    const csv = buildCsv(['Name', 'Note'], [['Khan, Ahsan', 'said "yes"'], ['Multi', 'line\nbreak']]);
    expect(csv).toContain('"Khan, Ahsan"');
    expect(csv).toContain('"said ""yes"""');
    expect(csv).toContain('"line\nbreak"');
  });

  it('keeps an empty cell empty rather than writing the word null', () => {
    const xml = buildXls([{ name: 'S', columns: ['A'], rows: [[null]] }], 'S');
    expect(xml).not.toContain('null');
  });
});
