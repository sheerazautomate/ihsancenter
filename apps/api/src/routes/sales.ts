import { Hono } from 'hono';
import { z } from 'zod';
import { postSale, voidSale } from '../lib/sales';
import { IDEMPOTENCY_HEADER } from '../lib/idempotency';
import { businessDate } from '../lib/numbering';
import { creditPanelParams, creditPanelSql, toCreditPanel, INVOICE_BALANCE_SQL } from '../lib/ledger';
import { requireAuth, type AppEnv } from '../middleware';

export const salesRoutes = new Hono<AppEnv>();

salesRoutes.use('*', requireAuth);

const lineSchema = z.object({
  productId: z.string().min(1),
  /** Quantity in units (2.5 kg). Converted to milli-units server-side. */
  qty: z.number().positive().max(1_000_000),
  /** Rate per unit in rupees. Converted to paisa server-side. */
  rate: z.number().min(0).max(100_000_000),
  discount: z.number().min(0).max(100_000_000).optional(),
});

const saleSchema = z.object({
  customerId: z.string().min(1),
  docDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  lines: z.array(lineSchema).min(1).max(200),
  invoiceDiscount: z.number().min(0).max(100_000_000).optional(),
  paidCash: z.number().min(0).max(100_000_000).optional(),
  paidBank: z.number().min(0).max(100_000_000).optional(),
  cashAccountId: z.string().optional(),
  bankAccountId: z.string().optional(),
  notes: z.string().max(500).optional(),
  overrideCredit: z.boolean().optional(),
  overrideReason: z.string().max(300).optional(),
});

/** Rupees (may be fractional) -> integer paisa. */
const toPaisa = (rupees: number | undefined): number | undefined =>
  rupees === undefined ? undefined : Math.round(rupees * 100);

salesRoutes.post('/', async (c) => {
  const parsed = saleSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json(
      { error: 'Invalid sale', details: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) },
      400,
    );
  }

  const body = parsed.data;
  const user = c.get('user');

  const settings = await c.env.DB.prepare(`SELECT allow_negative_stock FROM settings WHERE id = 1`)
    .first<{ allow_negative_stock: number }>();

  const result = await postSale(c.env.DB, {
    docDate: body.docDate ?? businessDate(),
    customerId: body.customerId,
    lines: body.lines.map((l) => ({
      productId: l.productId,
      qtyMilli: Math.round(l.qty * 1000),
      ratePaisa: toPaisa(l.rate)!,
      discountPaisa: toPaisa(l.discount),
    })),
    invoiceDiscountPaisa: toPaisa(body.invoiceDiscount),
    paidCashPaisa: toPaisa(body.paidCash),
    paidBankPaisa: toPaisa(body.paidBank),
    cashAccountId: body.cashAccountId,
    bankAccountId: body.bankAccountId,
    notes: body.notes,
    overrideCredit: body.overrideCredit,
    overrideReason: body.overrideReason,
    allowNegativeStock: settings?.allow_negative_stock === 1,
    userId: user.id,
    idempotencyKey: c.req.header(IDEMPOTENCY_HEADER) ?? undefined,
  });

  if (!result.ok) {
    // 409 for a business rule the manager can resolve (limit, stock), 400 for bad input.
    const status =
      result.code === 'credit_limit_exceeded' ||
      result.code === 'credit_hold' ||
      result.code === 'insufficient_stock'
        ? 409
        : 400;
    return c.json({ error: result.error, code: result.code }, status);
  }

  return c.json(
    { sale: result.sale, replayed: result.replayed ?? false },
    result.replayed ? 200 : 201,
  );
});

salesRoutes.post('/:id/void', async (c) => {
  const parsed = z
    .object({ reason: z.string().min(3).max(300) })
    .safeParse(await c.req.json().catch(() => null));

  if (!parsed.success) {
    return c.json({ error: 'A reason of at least 3 characters is required' }, 400);
  }

  const result = await voidSale(c.env.DB, {
    invoiceId: c.req.param('id'),
    reason: parsed.data.reason,
    userId: c.get('user').id,
  });

  if (!result.ok) return c.json({ error: result.error }, 400);
  return c.json({ sale: result.sale });
});

/** Invoice list with filters. Indexed on (doc_date, status) and (customer_id, doc_date). */
salesRoutes.get('/', async (c) => {
  const from = c.req.query('from') ?? '1970-01-01';
  const to = c.req.query('to') ?? '2999-12-31';
  const customerId = c.req.query('customerId');
  const limit = Math.min(Number(c.req.query('limit') ?? 50), 200);

  const rows = await c.env.DB.prepare(
    // outstanding_paisa is what makes the invoice list useful after a collection:
    // a bill can be listed as credit Rs 5,000 while only Rs 2,000 is still owed.
    `SELECT i.id, i.invoice_no, i.doc_date, i.total_paisa, i.credit_paisa, i.status,
            c.name AS customer_name,
            MAX(0, b.bal) AS outstanding_paisa,
            CASE
              WHEN i.credit_paisa = 0 THEN 'paid'
              WHEN b.bal <= 0 THEN 'settled'
              WHEN b.bal < i.credit_paisa THEN 'part'
              ELSE 'open'
            END AS pay_state,
            -- The dates the shop asks for at a glance: when the last money came
            -- in, and the date the bill finally reached zero.
            (SELECT MAX(r.doc_date) FROM receipt_allocations a
               JOIN customer_receipts r ON r.id = a.receipt_id AND r.status = 'open'
              WHERE a.invoice_id = i.id) AS last_paid_on,
            CASE WHEN i.credit_paisa > 0 AND b.bal <= 0
                 THEN (SELECT MAX(r.doc_date) FROM receipt_allocations a
                         JOIN customer_receipts r ON r.id = a.receipt_id AND r.status = 'open'
                        WHERE a.invoice_id = i.id)
                 ELSE NULL END AS cleared_on
     FROM sales_invoices i
     JOIN customers c ON c.id = i.customer_id
     LEFT JOIN (${INVOICE_BALANCE_SQL}) b ON b.id = i.id
     WHERE i.doc_date BETWEEN ? AND ?
       AND (? IS NULL OR i.customer_id = ?)
     ORDER BY i.doc_date DESC, i.id DESC
     LIMIT ?`,
  )
    .bind(from, to, customerId ?? null, customerId ?? null, limit)
    .all();

  return c.json({ invoices: rows.results });
});

/**
 * Full invoice for printing / reprint.
 *
 * `payment` carries what has actually been received against this bill since it was
 * issued. Without it a reprinted invoice kept showing the whole credit as still
 * owed long after the farmer had paid -- the shop handed out a receipt that said
 * "udhaar Rs 12,000" on an account that was clear.
 */
salesRoutes.get('/:id', async (c) => {
  const invoice = await c.env.DB.prepare(
    `SELECT i.*, c.name AS customer_name, c.phone AS customer_phone, c.village AS customer_village,
            COALESCE((SELECT SUM(a.amount_paisa) FROM receipt_allocations a
                       WHERE a.invoice_id = i.id), 0)
              + COALESCE((SELECT SUM(r.credit_note_paisa) FROM sale_returns r
                           WHERE r.invoice_id = i.id AND r.status = 'open'), 0) AS settled_paisa
     FROM sales_invoices i JOIN customers c ON c.id = i.customer_id WHERE i.id = ?`,
  )
    .bind(c.req.param('id'))
    .first<Record<string, unknown>>();

  if (!invoice) return c.json({ error: 'Invoice not found' }, 404);

  const settledPaisa = Number(invoice.settled_paisa ?? 0);
  const creditPaisa = Number(invoice.credit_paisa ?? 0);
  // Payment history, oldest first, with what the balance became after each one.
  // "Paid Rs 1,000 on 5 March" is not answerable from a single total: the farmer
  // needs to see each date and the balance it left, which is what he is checking
  // when he holds the slip up against his own notebook.
  const received = await c.env.DB.prepare(
    `SELECT r.receipt_no, r.doc_date, r.mode, a.amount_paisa, ca.name AS account_name
     FROM receipt_allocations a JOIN customer_receipts r ON r.id = a.receipt_id
     LEFT JOIN cash_accounts ca ON ca.id = r.cash_account_id
     WHERE a.invoice_id = ? AND r.status = 'open'
     ORDER BY r.doc_date ASC, r.created_at ASC`,
  )
    .bind(c.req.param('id'))
    .all<{
      receipt_no: string;
      doc_date: string;
      mode: string;
      amount_paisa: number;
      account_name: string | null;
    }>();

  // Credit notes from sale returns also settle a bill and carry their own date.
  const creditNotes = await c.env.DB.prepare(
    `SELECT return_no, doc_date, credit_note_paisa AS amount_paisa
     FROM sale_returns
     WHERE invoice_id = ? AND status = 'open' AND credit_note_paisa > 0
     ORDER BY doc_date ASC, created_at ASC`,
  )
    .bind(c.req.param('id'))
    .all<{ return_no: string; doc_date: string; amount_paisa: number }>();

  type HistoryRow = {
    date: string;
    document: string;
    kind: 'receipt' | 'credit note';
    mode: string;
    amountPaisa: number;
    balanceAfterPaisa: number;
  };

  const merged: Omit<HistoryRow, 'balanceAfterPaisa'>[] = [
    ...(received.results ?? []).map((r) => ({
      date: r.doc_date,
      document: r.receipt_no,
      kind: 'receipt' as const,
      mode: r.mode,
      amountPaisa: r.amount_paisa,
    })),
    ...(creditNotes.results ?? []).map((r) => ({
      date: r.doc_date,
      document: r.return_no,
      kind: 'credit note' as const,
      mode: 'return',
      amountPaisa: r.amount_paisa,
    })),
  ].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // Running balance down the history, never below zero, and the date it reached
  // zero -- that is the "cleared on" the shop needs to say out loud.
  let remaining = creditPaisa;
  let clearedOn: string | null = creditPaisa === 0 ? String(invoice.doc_date) : null;
  const history: HistoryRow[] = merged.map((row) => {
    remaining = Math.max(0, remaining - row.amountPaisa);
    if (remaining === 0 && !clearedOn) clearedOn = row.date;
    return { ...row, balanceAfterPaisa: remaining };
  });

  const lastPaidOn = merged.length > 0 ? merged[merged.length - 1].date : null;

  const payment = {
    settledPaisa,
    outstandingPaisa: Math.max(0, creditPaisa - settledPaisa),
    // Overpaid/credit-note cases: never show a negative "still owed".
    overpaidPaisa: Math.max(0, settledPaisa - creditPaisa),
    // Dates the shop asks about: when the bill was last touched, and when it was
    // finally done with. Null clearedOn means it is still outstanding.
    clearedOn,
    lastPaidOn,
    history,
    receipts: received.results,
  };

  const lines = await c.env.DB.prepare(
    `SELECT l.*, p.name AS product_name, p.unit, p.pack_size
     FROM sales_invoice_lines l JOIN products p ON p.id = l.product_id
     WHERE l.invoice_id = ? ORDER BY l.sort_order`,
  )
    .bind(c.req.param('id'))
    .all();

  return c.json({ invoice, lines: lines.results, payment });
});

/** The credit panel the billing screen shows before the manager commits. */
salesRoutes.get('/credit/:customerId', async (c) => {
  const customerId = c.req.param('customerId');
  const newCredit = toPaisa(Number(c.req.query('pending') ?? 0)) ?? 0;

  const row = await c.env.DB.prepare(creditPanelSql())
    .bind(...creditPanelParams(customerId))
    .first<Record<string, unknown>>();

  if (!row) return c.json({ error: 'Customer not found' }, 404);
  return c.json({ credit: toCreditPanel(row, newCredit) });
});

/** Unpaid invoices for a customer, for the receipt-allocation screen. */
salesRoutes.get('/unpaid/:customerId', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT * FROM (${INVOICE_BALANCE_SQL}) b
     WHERE b.customer_id = ? AND b.bal > 0
     ORDER BY b.doc_date ASC`,
  )
    .bind(c.req.param('customerId'))
    .all();

  return c.json({ invoices: rows.results });
});
