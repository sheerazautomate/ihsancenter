import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth, type AppEnv } from '../middleware';
import { newId } from '../lib/ids';
import { toPaisa } from '../lib/parse';
import { formatPkr } from '../lib/money';

export const catalogRoutes = new Hono<AppEnv>();

catalogRoutes.use('*', requireAuth);

/**
 * Companies. Active only by default, because every other screen (purchases,
 * payments, product form) wants only the companies it can still trade with.
 * `?all=1` includes deactivated ones for the management screen, where they must
 * remain visible in order to be reactivated.
 */
catalogRoutes.get('/companies', async (c) => {
  const all = c.req.query('all') === '1';
  const rows = await c.env.DB.prepare(
    // address and notes are included because the edit form is filled from this
    // list; omitting them would let "save" write blanks over real values.
    `SELECT id, name, contact_person, phone, address, notes, is_active FROM companies
     WHERE (? = 1 OR is_active = 1) ORDER BY name`,
  )
    .bind(all ? 1 : 0)
    .all();
  return c.json({ companies: rows.results });
});

/**
 * One company's detail: what it is, and what would stop it being deleted.
 *
 * The manager needs the delete answer BEFORE deciding, not as an error after
 * clicking. `usage` is the audit behind that answer.
 */
catalogRoutes.get('/companies/:id', async (c) => {
  const id = c.req.param('id');
  const company = await c.env.DB.prepare(
    `SELECT id, name, contact_person, phone, address, notes, is_active, created_at
     FROM companies WHERE id = ?`,
  )
    .bind(id)
    .first();
  if (!company) return c.json({ error: 'Company not found' }, 404);

  return c.json({ company, usage: await companyUsage(c.env.DB, id) });
});

/** What a company owns, and whether it is safe to remove. */
async function companyUsage(db: D1Database, id: string) {
  const row = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM products          WHERE company_id = ?) AS products,
         (SELECT COUNT(*) FROM purchases         WHERE company_id = ?) AS purchases,
         (SELECT COUNT(*) FROM purchase_returns  WHERE company_id = ?) AS purchaseReturns,
         (SELECT COUNT(*) FROM supplier_payments WHERE company_id = ?) AS payments,
         (SELECT
            (SELECT COUNT(*) FROM ledger_entries WHERE account_type = 'supplier' AND account_id = ?)
          + (SELECT COUNT(*) FROM ledger_entries WHERE account_type = 'inventory' AND doc_id IN
               (SELECT id FROM purchases WHERE company_id = ?))
         ) AS ledgerEntries,
         COALESCE((SELECT SUM(credit_paisa - debit_paisa) FROM ledger_entries
                    WHERE account_type = 'supplier' AND account_id = ?), 0) AS balancePaisa`,
    )
    .bind(id, id, id, id, id, id, id)
    .first<{
      products: number;
      purchases: number;
      purchaseReturns: number;
      payments: number;
      ledgerEntries: number;
      balancePaisa: number;
    }>();

  const u = row ?? {
    products: 0,
    purchases: 0,
    purchaseReturns: 0,
    payments: 0,
    ledgerEntries: 0,
    balancePaisa: 0,
  };

  // A balance of zero is NOT enough. A company can be fully paid off and still
  // own a catalogue and an invoice history; deleting it would either fail on a
  // foreign key or silently orphan the products that reference it.
  let blockedBy: string | null = null;
  if (u.balancePaisa !== 0) {
    blockedBy =
      u.balancePaisa > 0
        ? `you still owe them ${formatPkr(u.balancePaisa)}`
        : `they owe you ${formatPkr(-u.balancePaisa)}`;
  } else if (u.products > 0) {
    blockedBy = `${u.products} product(s) still belong to it`;
  } else if (u.purchases + u.purchaseReturns > 0) {
    blockedBy = `it has ${u.purchases + u.purchaseReturns} purchase document(s) — history would be lost`;
  } else if (u.payments > 0) {
    blockedBy = `${u.payments} payment(s) were made to it`;
  } else if (u.ledgerEntries > 0) {
    blockedBy = 'the ledger has entries against it';
  }

  return {
    ...u,
    canDelete: blockedBy === null,
    canDeactivate: true,
    blockedBy,
  };
}

const companySchema = z.object({
  name: z.string().min(1).max(120),
  contactPerson: z.string().max(120).nullable().optional(),
  phone: z.string().max(30).nullable().optional(),
  address: z.string().max(300).nullable().optional(),
  notes: z.string().max(500).nullable().optional(),
});

catalogRoutes.post('/companies', async (c) => {
  const parsed = companySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json(
      { error: 'A company name is required', details: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) },
      400,
    );
  }
  const d = parsed.data;
  const id = newId('co');

  try {
    await c.env.DB.prepare(
      `INSERT INTO companies (id, name, contact_person, phone, address, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        d.name.trim(),
        d.contactPerson ?? null,
        d.phone ?? null,
        d.address ?? null,
        d.notes ?? null,
        new Date().toISOString(),
      )
      .run();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/UNIQUE constraint failed/.test(message)) {
      return c.json({ error: 'A company with this name already exists' }, 409);
    }
    throw err;
  }

  return c.json({ id }, 201);
});

catalogRoutes.patch('/companies/:id', async (c) => {
  const id = c.req.param('id');
  const parsed = z
    .object({
      name: z.string().min(1).max(120).optional(),
      contactPerson: z.string().max(120).nullable().optional(),
      phone: z.string().max(30).nullable().optional(),
      address: z.string().max(300).nullable().optional(),
      notes: z.string().max(500).nullable().optional(),
      isActive: z.boolean().optional(),
    })
    .safeParse(await c.req.json().catch(() => null));

  if (!parsed.success) return c.json({ error: 'Invalid update' }, 400);
  const d = parsed.data;

  const sets: string[] = [];
  const params: unknown[] = [];
  if (d.name !== undefined) { sets.push('name = ?'); params.push(d.name.trim()); }
  if (d.contactPerson !== undefined) { sets.push('contact_person = ?'); params.push(d.contactPerson); }
  if (d.phone !== undefined) { sets.push('phone = ?'); params.push(d.phone); }
  if (d.address !== undefined) { sets.push('address = ?'); params.push(d.address); }
  if (d.notes !== undefined) { sets.push('notes = ?'); params.push(d.notes); }
  if (d.isActive !== undefined) { sets.push('is_active = ?'); params.push(d.isActive ? 1 : 0); }

  if (sets.length === 0) return c.json({ error: 'Nothing to update' }, 400);
  params.push(id);

  try {
    const result = await c.env.DB.prepare(`UPDATE companies SET ${sets.join(', ')} WHERE id = ?`)
      .bind(...params)
      .run();
    if (!result.meta.changes) return c.json({ error: 'Company not found' }, 404);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/UNIQUE constraint failed/.test(message)) {
      return c.json({ error: 'A company with this name already exists' }, 409);
    }
    throw err;
  }

  return c.json({ ok: true });
});

/**
 * Delete a company, but only a genuinely unused one.
 *
 * The guard is a full dependency audit rather than "balance is zero", because a
 * company can be fully paid and still own a product catalogue and a purchase
 * history. Removing it would either fail on a foreign key (an ugly 500) or, if
 * the key were ever dropped, silently orphan every product that pointed at it.
 *
 * `canDelete` from GET /companies/:id is advisory; this re-checks inside the
 * request so a stale screen cannot delete something that has since gained data.
 */
catalogRoutes.delete('/companies/:id', async (c) => {
  const id = c.req.param('id');

  const company = await c.env.DB.prepare(`SELECT id FROM companies WHERE id = ?`).bind(id).first();
  if (!company) return c.json({ error: 'Company not found' }, 404);

  const usage = await companyUsage(c.env.DB, id);
  if (!usage.canDelete) {
    return c.json(
      {
        error: `Cannot delete this company: ${usage.blockedBy}. Deactivate it instead — it stays out of new purchases without disturbing the books.`,
        code: 'company_in_use',
        usage,
      },
      409,
    );
  }

  await c.env.DB.prepare(`DELETE FROM companies WHERE id = ?`).bind(id).run();
  return c.json({ ok: true, deleted: id });
});

/**
 * Product search for the billing screen.
 *
 * One indexed LIKE prefix scan on name/sku/barcode. At ~800 SKUs this is
 * sub-millisecond; FTS5 would be premature.
 */
catalogRoutes.get('/products', async (c) => {
  const q = (c.req.query('q') ?? '').trim();
  const companyId = c.req.query('companyId');
  const limit = Math.min(Number(c.req.query('limit') ?? 20), 100);

  const rows = await c.env.DB.prepare(
    `SELECT p.id, p.name, p.sku, p.barcode, p.category, p.unit, p.pack_size,
            p.sale_rate_paisa, p.purchase_rate_paisa, p.qty_on_hand_milli,
            p.reorder_level_milli, p.company_id, co.name AS company_name
     FROM products p
     JOIN companies co ON co.id = p.company_id
     WHERE p.is_active = 1
       AND (? = '' OR p.name LIKE ? OR p.sku LIKE ? OR p.barcode = ?)
       AND (? IS NULL OR p.company_id = ?)
     ORDER BY
       CASE WHEN p.barcode = ? THEN 0 WHEN p.name LIKE ? THEN 1 ELSE 2 END,
       p.name
     LIMIT ?`,
  )
    .bind(
      q,
      `${q}%`,
      `${q}%`,
      q,
      companyId ?? null,
      companyId ?? null,
      q,
      `${q}%`,
      limit,
    )
    .all();

  return c.json({ products: rows.results });
});

const productSchema = z.object({
  name: z.string().min(1).max(120),
  companyId: z.string().min(1),
  category: z.enum(['insecticide', 'fungicide', 'herbicide', 'fertilizer', 'seed', 'other']),
  unit: z.string().max(20).optional(),
  packSize: z.string().max(40).optional(),
  sku: z.string().max(40).optional(),
  barcode: z.string().max(60).optional(),
  purchaseRate: z.number().min(0).max(100_000_000),
  saleRate: z.number().min(0).max(100_000_000),
  reorderLevel: z.number().min(0).optional(),
  openingQty: z.number().min(0).optional(),
});

catalogRoutes.post('/products', async (c) => {
  const parsed = productSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json(
      { error: 'Invalid product', details: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) },
      400,
    );
  }
  const p = parsed.data;
  const now = new Date().toISOString();
  const id = newId('prod');
  const qtyMilli = Math.round((p.openingQty ?? 0) * 1000);
  const costPaisa = toPaisa(p.purchaseRate);

  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO products (id, company_id, name, sku, barcode, category, unit, pack_size,
           purchase_rate_paisa, sale_rate_paisa, avg_cost_paisa, reorder_level_milli,
           qty_on_hand_milli, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        id,
        p.companyId,
        p.name,
        p.sku ?? null,
        p.barcode ?? null,
        p.category,
        p.unit ?? 'pcs',
        p.packSize ?? null,
        costPaisa,
        toPaisa(p.saleRate),
        costPaisa,
        Math.round((p.reorderLevel ?? 0) * 1000),
        qtyMilli,
        now,
        now,
      ),
      ...(qtyMilli > 0
        ? [
            c.env.DB.prepare(
              `INSERT INTO stock_movements
                 (id, product_id, movement_date, type, qty_change_milli, unit_cost_paisa,
                  doc_type, doc_id, balance_after_milli, note, created_at)
               VALUES (?, ?, ?, 'opening', ?, ?, 'opening', ?, ?, 'Opening stock', ?)`,
            ).bind(
              newId('sm'),
              id,
              new Date().toISOString().slice(0, 10),
              qtyMilli,
              costPaisa,
              id,
              qtyMilli,
              now,
            ),
          ]
        : []),
    ]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/UNIQUE constraint failed/.test(message)) {
      return c.json({ error: 'A product with this name already exists for that company' }, 409);
    }
    throw err;
  }

  return c.json({ id }, 201);
});

/**
 * Edit a product.
 *
 * Deliberately partial and narrow: descriptions, rates and the reorder level only.
 *
 * NOT editable here, each for a reason that would be a support call later:
 *   - `qty_on_hand_milli` -- stock moves through documents, never a form. An
 *     editable quantity would let the count and the ledger disagree.
 *   - `company_id` -- a product's company decides which payable the purchase hits
 *     and how the company totals report. Moving it would silently restate history.
 *   - `avg_cost_paisa` -- computed from purchases.
 *
 * Changing a rate is FORWARD-ONLY: invoices already issued keep the price they
 * were billed at, because their lines store the rate. The response says how many
 * past documents were affected so the manager is told, not surprised.
 */
const productPatchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  category: z.enum(['insecticide', 'fungicide', 'herbicide', 'fertilizer', 'seed', 'other']).optional(),
  unit: z.string().min(1).max(20).optional(),
  packSize: z.string().max(40).nullable().optional(),
  sku: z.string().max(40).nullable().optional(),
  barcode: z.string().max(60).nullable().optional(),
  purchaseRate: z.number().min(0).max(100_000_000).optional(),
  saleRate: z.number().min(0).max(100_000_000).optional(),
  reorderLevel: z.number().min(0).optional(),
});

catalogRoutes.patch('/products/:id', async (c) => {
  const id = c.req.param('id');
  const parsed = productPatchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json(
      { error: 'Invalid update', details: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) },
      400,
    );
  }
  const d = parsed.data;

  const sets: string[] = [];
  const params: unknown[] = [];
  const now = new Date().toISOString();

  if (d.name !== undefined) { sets.push('name = ?'); params.push(d.name.trim()); }
  if (d.category !== undefined) { sets.push('category = ?'); params.push(d.category); }
  if (d.unit !== undefined) { sets.push('unit = ?'); params.push(d.unit); }
  if (d.packSize !== undefined) { sets.push('pack_size = ?'); params.push(d.packSize); }
  if (d.sku !== undefined) { sets.push('sku = ?'); params.push(d.sku); }
  if (d.barcode !== undefined) { sets.push('barcode = ?'); params.push(d.barcode); }
  if (d.purchaseRate !== undefined) { sets.push('purchase_rate_paisa = ?'); params.push(toPaisa(d.purchaseRate)); }
  if (d.saleRate !== undefined) { sets.push('sale_rate_paisa = ?'); params.push(toPaisa(d.saleRate)); }
  if (d.reorderLevel !== undefined) { sets.push('reorder_level_milli = ?'); params.push(Math.round(d.reorderLevel * 1000)); }

  if (sets.length === 0) return c.json({ error: 'Nothing to update' }, 400);

  sets.push('updated_at = ?');
  params.push(now);
  params.push(id);

  try {
    const result = await c.env.DB.prepare(
      `UPDATE products SET ${sets.join(', ')} WHERE id = ? AND is_active = 1`,
    )
      .bind(...params)
      .run();

    if (!result.meta.changes) return c.json({ error: 'Product not found' }, 404);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/UNIQUE constraint failed/.test(message)) {
      return c.json({ error: 'A product with this name already exists for that company' }, 409);
    }
    throw err;
  }

  // How much history this rate change sits alongside. Informational, not a block:
  // past invoices are immutable and keep their own rates.
  const history = await c.env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM sales_invoice_lines WHERE product_id = ?) AS saleLines,
       (SELECT COUNT(*) FROM purchase_lines WHERE product_id = ?) AS purchaseLines`,
  )
    .bind(id, id)
    .first<{ saleLines: number; purchaseLines: number }>();

  return c.json({
    ok: true,
    affected: {
      saleLines: history?.saleLines ?? 0,
      purchaseLines: history?.purchaseLines ?? 0,
    },
  });
});

/** Stock list with status, for the inventory screen. */
catalogRoutes.get('/stock', async (c) => {
  const onlyLow = c.req.query('low') === '1';
  const rows = await c.env.DB.prepare(
    `SELECT p.id, p.name, p.unit, p.pack_size, p.qty_on_hand_milli, p.reorder_level_milli,
            p.sale_rate_paisa, p.purchase_rate_paisa, p.category,
            co.name AS company_name, p.company_id
     FROM products p JOIN companies co ON co.id = p.company_id
     WHERE p.is_active = 1
       AND (? = 0 OR p.qty_on_hand_milli <= p.reorder_level_milli)
     ORDER BY p.qty_on_hand_milli ASC, p.name
     LIMIT 500`,
  )
    .bind(onlyLow ? 1 : 0)
    .all();
  return c.json({ stock: rows.results });
});
