import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth, type AppEnv } from '../middleware';
import { newId } from '../lib/ids';
import { toPaisa } from '../lib/parse';

export const customerRoutes = new Hono<AppEnv>();

customerRoutes.use('*', requireAuth);

customerRoutes.get('/', async (c) => {
  const q = (c.req.query('q') ?? '').trim();
  const limit = Math.min(Number(c.req.query('limit') ?? 30), 100);

  const rows = await c.env.DB.prepare(
    `SELECT c.id, c.name, c.phone, c.village, c.type, c.credit_limit_paisa,
            c.is_credit_hold,
            COALESCE((SELECT SUM(l.debit_paisa - l.credit_paisa) FROM ledger_entries l
                       WHERE l.account_type = 'customer' AND l.account_id = c.id), 0) AS outstanding_paisa
     FROM customers c
     WHERE c.is_active = 1
       AND (? = '' OR c.name LIKE ? OR c.phone LIKE ? OR c.village LIKE ?)
     ORDER BY CASE WHEN c.name LIKE ? THEN 0 ELSE 1 END, c.name
     LIMIT ?`,
  )
    .bind(q, `${q}%`, `${q}%`, `${q}%`, `${q}%`, limit)
    .all();

  return c.json({ customers: rows.results });
});

/** Quick-add from the billing screen: name required, everything else optional. */
const createSchema = z.object({
  name: z.string().min(1).max(120),
  phone: z.string().max(30).optional(),
  village: z.string().max(80).optional(),
  // Kept in step with the customers.type CHECK constraint in 0001_init.sql.
  // 'walkin' is the anonymous counter customer and is never set from a form, but
  // it must stay accepted because the billing screen may reference it.
  type: z.enum(['farmer', 'dealer', 'walkin']).optional(),
  creditLimit: z.number().min(0).max(100_000_000).optional(),
});

customerRoutes.post('/', async (c) => {
  const parsed = createSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'A customer name is required' }, 400);

  const d = parsed.data;
  const id = newId('cust');

  try {
    await c.env.DB.prepare(
      `INSERT INTO customers (id, name, phone, village, type, credit_limit_paisa, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        d.name,
        d.phone || null,
        d.village || null,
        d.type ?? 'farmer',
        toPaisa(d.creditLimit ?? 0),
        new Date().toISOString(),
      )
      .run();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/UNIQUE constraint failed/.test(message)) {
      return c.json({ error: 'A customer with this phone number already exists' }, 409);
    }
    throw err;
  }

  return c.json({ id }, 201);
});

customerRoutes.patch('/:id', async (c) => {
  const parsed = z
    .object({
      name: z.string().min(1).max(120).optional(),
      phone: z.string().max(30).nullable().optional(),
      village: z.string().max(80).nullable().optional(),
      creditLimit: z.number().min(0).max(100_000_000).optional(),
      isCreditHold: z.boolean().optional(),
    })
    .safeParse(await c.req.json().catch(() => null));

  if (!parsed.success) return c.json({ error: 'Invalid update' }, 400);

  const d = parsed.data;
  const sets: string[] = [];
  const params: unknown[] = [];

  if (d.name !== undefined) { sets.push('name = ?'); params.push(d.name); }
  if (d.phone !== undefined) { sets.push('phone = ?'); params.push(d.phone); }
  if (d.village !== undefined) { sets.push('village = ?'); params.push(d.village); }
  if (d.creditLimit !== undefined) { sets.push('credit_limit_paisa = ?'); params.push(toPaisa(d.creditLimit)); }
  if (d.isCreditHold !== undefined) { sets.push('is_credit_hold = ?'); params.push(d.isCreditHold ? 1 : 0); }

  if (sets.length === 0) return c.json({ error: 'Nothing to update' }, 400);

  params.push(c.req.param('id'));
  const result = await c.env.DB.prepare(`UPDATE customers SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...params)
    .run();

  if (!result.meta.changes) return c.json({ error: 'Customer not found' }, 404);
  return c.json({ ok: true });
});

/** Customer ledger: every movement with a running balance. */
customerRoutes.get('/:id/ledger', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT entry_date, doc_type, doc_id, debit_paisa, credit_paisa, memo,
            SUM(debit_paisa - credit_paisa) OVER (ORDER BY entry_date, id) AS running_paisa
     FROM ledger_entries
     WHERE account_type = 'customer' AND account_id = ?
     ORDER BY entry_date, id
     LIMIT 500`,
  )
    .bind(c.req.param('id'))
    .all();

  return c.json({ entries: rows.results });
});
