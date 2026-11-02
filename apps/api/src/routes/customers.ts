import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth, type AppEnv } from '../middleware';
import { newId } from '../lib/ids';
import { toPaisa } from '../lib/parse';
import { formatPkr } from '../lib/money';

export const customerRoutes = new Hono<AppEnv>();

customerRoutes.use('*', requireAuth);

customerRoutes.get('/', async (c) => {
  const q = (c.req.query('q') ?? '').trim();
  const limit = Math.min(Number(c.req.query('limit') ?? 30), 100);
  // Active only by default: billing and receipts must not offer a customer that
  // was hidden. `?all=1` brings them back for the management screen, otherwise
  // deactivating someone removes them with no route to undo it.
  const all = c.req.query('all') === '1';

  const rows = await c.env.DB.prepare(
    `SELECT c.id, c.name, c.phone, c.village, c.type, c.credit_limit_paisa,
            c.is_credit_hold, c.is_active,
            COALESCE((SELECT SUM(l.debit_paisa - l.credit_paisa) FROM ledger_entries l
                       WHERE l.account_type = 'customer' AND l.account_id = c.id), 0) AS outstanding_paisa
     FROM customers c
     WHERE (? = 1 OR c.is_active = 1)
       AND (? = '' OR c.name LIKE ? OR c.phone LIKE ? OR c.village LIKE ?)
     ORDER BY CASE WHEN c.name LIKE ? THEN 0 ELSE 1 END, c.name
     LIMIT ?`,
  )
    .bind(all ? 1 : 0, q, `${q}%`, `${q}%`, `${q}%`, `${q}%`, limit)
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
      isActive: z.boolean().optional(),
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
  if (d.isActive !== undefined) { sets.push('is_active = ?'); params.push(d.isActive ? 1 : 0); }

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

/**
 * What a customer owns, and whether it is safe to remove.
 *
 * Same shape as the company audit, for the same reason: a zero balance is not
 * enough. A customer can owe nothing and still have twenty invoices behind them,
 * and deleting that row either fails on a foreign key or orphans the history.
 */
async function customerUsage(db: D1Database, id: string) {
  const row = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM sales_invoices  WHERE customer_id = ?) AS invoices,
         (SELECT COUNT(*) FROM sale_returns    WHERE customer_id = ?) AS returns,
         (SELECT COUNT(*) FROM customer_receipts WHERE customer_id = ?) AS receipts,
         (SELECT COUNT(*) FROM ledger_entries
           WHERE account_type = 'customer' AND account_id = ?) AS ledgerEntries,
         COALESCE((SELECT SUM(debit_paisa - credit_paisa) FROM ledger_entries
                    WHERE account_type = 'customer' AND account_id = ?), 0) AS balancePaisa,
         (SELECT type FROM customers WHERE id = ?) AS type`,
    )
    .bind(id, id, id, id, id, id)
    .first<{
      invoices: number;
      returns: number;
      receipts: number;
      ledgerEntries: number;
      balancePaisa: number;
      type: string | null;
    }>();

  const u = row ?? {
    invoices: 0,
    returns: 0,
    receipts: 0,
    ledgerEntries: 0,
    balancePaisa: 0,
    type: null,
  };

  // The walk-in customer is infrastructure, not a person. Billing posts cash sales
  // against it by id; deleting it would break the till.
  if (u.type === 'walkin') {
    return {
      ...u,
      canDelete: false,
      canDeactivate: false,
      blockedBy: 'this is the walk-in cash customer that the billing screen uses for cash sales',
    };
  }

  let blockedBy: string | null = null;
  if (u.balancePaisa > 0) {
    blockedBy = `they still owe ${formatPkr(u.balancePaisa)}`;
  } else if (u.balancePaisa < 0) {
    blockedBy = `they are holding ${formatPkr(-u.balancePaisa)} of the shop's money (an advance or overpaid receipt)`;
  } else if (u.invoices > 0) {
    blockedBy = `${u.invoices} invoice(s) are in their name — the sales history would be lost`;
  } else if (u.returns > 0) {
    blockedBy = `${u.returns} sale return(s) are recorded against them`;
  } else if (u.receipts > 0) {
    blockedBy = `${u.receipts} receipt(s) were collected from them`;
  } else if (u.ledgerEntries > 0) {
    blockedBy = 'the ledger has entries against them';
  }

  return { ...u, canDelete: blockedBy === null, canDeactivate: true, blockedBy };
}

/** What a customer owns, and whether it is safe to remove. */
customerRoutes.get('/:id/usage', async (c) => {
  const id = c.req.param('id');
  const exists = await c.env.DB.prepare(`SELECT id FROM customers WHERE id = ?`).bind(id).first();
  if (!exists) return c.json({ error: 'Customer not found' }, 404);

  return c.json({ usage: await customerUsage(c.env.DB, id) });
});

/**
 * Delete a customer.
 *
 * Meant for the two cases a paper register never had: somebody typed the name
 * twice, or typed a customer who does not exist. Those rows have no history, so
 * they go. Anything with a single invoice, receipt or ledger line is refused --
 * deactivate instead, which stops them being offered without touching the books.
 */
customerRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id');

  const customer = await c.env.DB.prepare(`SELECT id, name FROM customers WHERE id = ?`)
    .bind(id)
    .first<{ id: string; name: string }>();
  if (!customer) return c.json({ error: 'Customer not found' }, 404);

  const usage = await customerUsage(c.env.DB, id);
  if (!usage.canDelete) {
    // Only offer deactivation when it is actually possible. Telling a manager to
    // deactivate the walk-in customer would send them to a button that is not there.
    const advice = usage.canDeactivate
      ? ' Deactivate them instead — they stop appearing in billing, and the history stays.'
      : '';
    return c.json(
      {
        error: `Cannot delete ${customer.name}: ${usage.blockedBy}.${advice}`,
        code: 'customer_in_use',
        usage,
      },
      409,
    );
  }

  // No deps means no ledger rows and no documents: a single statement is safe.
  // (D1 has no interactive transactions, so every multi-statement delete here has
  // to be a batch; there is nothing to batch.)
  await c.env.DB.prepare(`DELETE FROM customers WHERE id = ?`).bind(id).run();
  return c.json({ ok: true, deleted: id });
});
