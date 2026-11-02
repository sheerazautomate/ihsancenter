import { Hono } from 'hono';
import { z } from 'zod';
import { postExpense, postReceipt } from '../lib/receipts';
import { businessDate } from '../lib/numbering';
import { requireAuth, type AppEnv } from '../middleware';
import { toPaisa } from '../lib/parse';
import { IDEMPOTENCY_HEADER } from '../lib/idempotency';

export const moneyRoutes = new Hono<AppEnv>();

moneyRoutes.use('*', requireAuth);

/** Money received from a customer, allocated to their oldest unpaid invoices. */
moneyRoutes.post('/receipts', async (c) => {
  const parsed = z
    .object({
      customerId: z.string().min(1),
      docDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      amount: z.number().positive().max(100_000_000),
      mode: z.enum(['cash', 'bank', 'cheque']),
      cashAccountId: z.string().min(1),
      reference: z.string().max(80).optional(),
      notes: z.string().max(300).optional(),
      allocations: z
        .array(z.object({ invoiceId: z.string(), amount: z.number().positive() }))
        .optional(),
    })
    .safeParse(await c.req.json().catch(() => null));

  if (!parsed.success) {
    return c.json(
      { error: 'Invalid receipt', details: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) },
      400,
    );
  }
  const b = parsed.data;

  const result = await postReceipt(c.env.DB, {
    docDate: b.docDate ?? businessDate(),
    customerId: b.customerId,
    amountPaisa: toPaisa(b.amount),
    mode: b.mode,
    cashAccountId: b.cashAccountId,
    reference: b.reference,
    notes: b.notes,
    allocations: b.allocations?.map((a) => ({
      invoiceId: a.invoiceId,
      amountPaisa: toPaisa(a.amount),
    })),
    userId: c.get('user').id,
    idempotencyKey: c.req.header(IDEMPOTENCY_HEADER) ?? undefined,
  });

  if (!result.ok) return c.json({ error: result.error, code: result.code }, 400);
  return c.json(result, result.replayed ? 200 : 201);
});

moneyRoutes.get('/receipts', async (c) => {
  const from = c.req.query('from') ?? '1970-01-01';
  const to = c.req.query('to') ?? '2999-12-31';

  const rows = await c.env.DB.prepare(
    `SELECT r.id, r.receipt_no, r.doc_date, r.amount_paisa, r.mode, c.name AS customer_name
     FROM customer_receipts r JOIN customers c ON c.id = r.customer_id
     WHERE r.doc_date BETWEEN ? AND ? AND r.status = 'open'
     ORDER BY r.doc_date DESC, r.id DESC LIMIT 200`,
  )
    .bind(from, to)
    .all();

  return c.json({ receipts: rows.results });
});

moneyRoutes.post('/expenses', async (c) => {
  const parsed = z
    .object({
      categoryId: z.string().min(1),
      docDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      amount: z.number().positive().max(100_000_000),
      cashAccountId: z.string().min(1),
      payee: z.string().max(120).optional(),
      notes: z.string().max(300).optional(),
    })
    .safeParse(await c.req.json().catch(() => null));

  if (!parsed.success) return c.json({ error: 'Invalid expense' }, 400);
  const b = parsed.data;

  const result = await postExpense(c.env.DB, {
    docDate: b.docDate ?? businessDate(),
    categoryId: b.categoryId,
    amountPaisa: toPaisa(b.amount),
    cashAccountId: b.cashAccountId,
    payee: b.payee,
    notes: b.notes,
    userId: c.get('user').id,
    idempotencyKey: c.req.header(IDEMPOTENCY_HEADER) ?? undefined,
  });

  if (!result.ok) return c.json({ error: result.error }, 400);
  return c.json(result, 201);
});

moneyRoutes.get('/expenses', async (c) => {
  const from = c.req.query('from') ?? '1970-01-01';
  const to = c.req.query('to') ?? '2999-12-31';

  const rows = await c.env.DB.prepare(
    `SELECT e.id, e.doc_date, e.amount_paisa, e.payee, e.notes, ec.name AS category_name
     FROM expenses e JOIN expense_categories ec ON ec.id = e.category_id
     WHERE e.doc_date BETWEEN ? AND ? AND e.status = 'open'
     ORDER BY e.doc_date DESC, e.id DESC LIMIT 200`,
  )
    .bind(from, to)
    .all();

  return c.json({ expenses: rows.results });
});

moneyRoutes.get('/categories', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT id, name FROM expense_categories WHERE is_active = 1 ORDER BY name`,
  ).all();
  return c.json({ categories: rows.results });
});

moneyRoutes.get('/accounts', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT id, name, type, bank_name, account_no FROM cash_accounts WHERE is_active = 1
     ORDER BY type DESC, name`,
  ).all();
  return c.json({ accounts: rows.results });
});
