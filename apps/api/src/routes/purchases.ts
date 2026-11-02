import { Hono } from 'hono';
import { z } from 'zod';
import { postPurchase, postPurchaseReturn, postSupplierPayment } from '../lib/purchases';
import { businessDate } from '../lib/numbering';
import { requireAuth, type AppEnv } from '../middleware';
import { toPaisa } from '../lib/parse';
import { IDEMPOTENCY_HEADER } from '../lib/idempotency';

export const purchaseRoutes = new Hono<AppEnv>();

purchaseRoutes.use('*', requireAuth);

const lineSchema = z.object({
  productId: z.string().min(1),
  qty: z.number().positive().max(1_000_000),
  rate: z.number().min(0).max(100_000_000),
  discount: z.number().min(0).max(100_000_000).optional(),
});

const purchaseSchema = z.object({
  companyId: z.string().min(1),
  docDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  supplierInvoiceNo: z.string().max(60).optional(),
  lines: z.array(lineSchema).min(1).max(200),
  discount: z.number().min(0).max(100_000_000).optional(),
  freight: z.number().min(0).max(100_000_000).optional(),
  paidCash: z.number().min(0).max(100_000_000).optional(),
  paidBank: z.number().min(0).max(100_000_000).optional(),
  cashAccountId: z.string().optional(),
  bankAccountId: z.string().optional(),
  notes: z.string().max(500).optional(),
});

purchaseRoutes.post('/', async (c) => {
  const parsed = purchaseSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json(
      { error: 'Invalid purchase', details: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) },
      400,
    );
  }
  const b = parsed.data;

  const result = await postPurchase(c.env.DB, {
    docDate: b.docDate ?? businessDate(),
    companyId: b.companyId,
    supplierInvoiceNo: b.supplierInvoiceNo,
    lines: b.lines.map((l) => ({
      productId: l.productId,
      qtyMilli: Math.round(l.qty * 1000),
      ratePaisa: toPaisa(l.rate),
      discountPaisa: l.discount !== undefined ? toPaisa(l.discount) : undefined,
    })),
    discountPaisa: b.discount !== undefined ? toPaisa(b.discount) : undefined,
    freightPaisa: b.freight !== undefined ? toPaisa(b.freight) : undefined,
    paidCashPaisa: b.paidCash !== undefined ? toPaisa(b.paidCash) : undefined,
    paidBankPaisa: b.paidBank !== undefined ? toPaisa(b.paidBank) : undefined,
    cashAccountId: b.cashAccountId,
    bankAccountId: b.bankAccountId,
    notes: b.notes,
    userId: c.get('user').id,
    idempotencyKey: c.req.header(IDEMPOTENCY_HEADER) ?? undefined,
  });

  if (!result.ok) return c.json({ error: result.error, code: result.code }, 400);
  return c.json(result, result.replayed ? 200 : 201);
});

purchaseRoutes.get('/', async (c) => {
  const from = c.req.query('from') ?? '1970-01-01';
  const to = c.req.query('to') ?? '2999-12-31';
  const companyId = c.req.query('companyId');

  const rows = await c.env.DB.prepare(
    `SELECT p.id, p.purchase_no, p.doc_date, p.total_paisa, p.payable_paisa, p.status,
            co.name AS company_name, p.supplier_invoice_no
     FROM purchases p JOIN companies co ON co.id = p.company_id
     WHERE p.doc_date BETWEEN ? AND ?
       AND (? IS NULL OR p.company_id = ?)
     ORDER BY p.doc_date DESC, p.id DESC
     LIMIT 200`,
  )
    .bind(from, to, companyId ?? null, companyId ?? null)
    .all();

  return c.json({ purchases: rows.results });
});

purchaseRoutes.get('/:id', async (c) => {
  const purchase = await c.env.DB.prepare(
    `SELECT p.*, co.name AS company_name FROM purchases p
     JOIN companies co ON co.id = p.company_id WHERE p.id = ?`,
  )
    .bind(c.req.param('id'))
    .first();
  if (!purchase) return c.json({ error: 'Purchase not found' }, 404);

  const lines = await c.env.DB.prepare(
    `SELECT l.*, pr.name AS product_name, pr.unit, pr.pack_size
     FROM purchase_lines l JOIN products pr ON pr.id = l.product_id
     WHERE l.purchase_id = ?`,
  )
    .bind(c.req.param('id'))
    .all();

  return c.json({ purchase, lines: lines.results });
});

purchaseRoutes.post('/returns', async (c) => {
  const parsed = z
    .object({
      companyId: z.string().min(1),
      purchaseId: z.string().optional(),
      docDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      lines: z.array(lineSchema).min(1),
      refundCash: z.number().min(0).optional(),
      refundBank: z.number().min(0).optional(),
      cashAccountId: z.string().optional(),
      bankAccountId: z.string().optional(),
      reason: z.string().min(3).max(300),
    })
    .safeParse(await c.req.json().catch(() => null));

  if (!parsed.success) return c.json({ error: 'Invalid purchase return' }, 400);
  const b = parsed.data;

  const result = await postPurchaseReturn(c.env.DB, {
    docDate: b.docDate ?? businessDate(),
    companyId: b.companyId,
    purchaseId: b.purchaseId,
    lines: b.lines.map((l) => ({
      productId: l.productId,
      qtyMilli: Math.round(l.qty * 1000),
      ratePaisa: toPaisa(l.rate),
      discountPaisa: l.discount !== undefined ? toPaisa(l.discount) : undefined,
    })),
    refundCashPaisa: b.refundCash !== undefined ? toPaisa(b.refundCash) : undefined,
    refundBankPaisa: b.refundBank !== undefined ? toPaisa(b.refundBank) : undefined,
    cashAccountId: b.cashAccountId,
    bankAccountId: b.bankAccountId,
    reason: b.reason,
    userId: c.get('user').id,
  });

  if (!result.ok) return c.json({ error: result.error }, 400);
  return c.json(result, 201);
});

/** Payment to a company. Also reachable from the payables screen. */
purchaseRoutes.post('/payments', async (c) => {
  const parsed = z
    .object({
      companyId: z.string().min(1),
      docDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      amount: z.number().positive().max(100_000_000),
      mode: z.enum(['cash', 'bank', 'cheque']),
      cashAccountId: z.string().min(1),
      reference: z.string().max(80).optional(),
      notes: z.string().max(300).optional(),
    })
    .safeParse(await c.req.json().catch(() => null));

  if (!parsed.success) {
    return c.json(
      { error: 'Invalid payment', details: parsed.error.issues.map((i) => i.message) },
      400,
    );
  }
  const b = parsed.data;

  const result = await postSupplierPayment(c.env.DB, {
    docDate: b.docDate ?? businessDate(),
    companyId: b.companyId,
    amountPaisa: toPaisa(b.amount),
    mode: b.mode,
    cashAccountId: b.cashAccountId,
    reference: b.reference,
    notes: b.notes,
    userId: c.get('user').id,
    idempotencyKey: c.req.header(IDEMPOTENCY_HEADER) ?? undefined,
  });

  if (!result.ok) return c.json({ error: result.error }, 400);
  return c.json(result, result.replayed ? 200 : 201);
});

/**
 * A company's unpaid bills, oldest first.
 *
 * Purchases are not allocated against payments the way invoices are against
 * receipts (there is no supplier_allocation table), so a bill cannot be marked
 * paid one by one. What this answers is "which bills make up what I owe", which
 * is what a manager needs while standing in front of the supplier.
 */
purchaseRoutes.get('/unpaid/:companyId', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT p.id, p.purchase_no, p.doc_date, p.supplier_invoice_no,
            p.total_paisa, p.payable_paisa,
            COALESCE((SELECT SUM(l.line_total_paisa) FROM purchase_lines l
                       WHERE l.purchase_id = p.id), 0) AS lines_paisa,
            COALESCE((SELECT COUNT(*) FROM purchase_lines l
                       WHERE l.purchase_id = p.id), 0) AS line_count
     FROM purchases p
     WHERE p.company_id = ? AND p.status = 'open' AND p.payable_paisa > 0
     ORDER BY p.doc_date ASC, p.id ASC`,
  )
    .bind(c.req.param('companyId'))
    .all();

  return c.json({ purchases: rows.results });
});

/** Payments already made to one company, newest first. */
purchaseRoutes.get('/payments/:companyId', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT id, payment_no, doc_date, amount_paisa, mode, reference, notes
     FROM supplier_payments
     WHERE company_id = ?
     ORDER BY doc_date DESC, created_at DESC
     LIMIT 50`,
  )
    .bind(c.req.param('companyId'))
    .all();

  return c.json({ payments: rows.results });
});
