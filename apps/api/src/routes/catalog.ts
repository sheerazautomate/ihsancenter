import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth, type AppEnv } from '../middleware';
import { newId } from '../lib/ids';
import { toPaisa } from '../lib/parse';

export const catalogRoutes = new Hono<AppEnv>();

catalogRoutes.use('*', requireAuth);

catalogRoutes.get('/companies', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT id, name, contact_person, phone, is_active FROM companies
     WHERE is_active = 1 ORDER BY name`,
  ).all();
  return c.json({ companies: rows.results });
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
