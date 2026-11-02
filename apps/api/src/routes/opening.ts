import { Hono } from 'hono';
import { z } from 'zod';
import { getOpeningState, postOpeningBalances } from '../lib/opening';
import { businessDate } from '../lib/numbering';
import { requireAuth, type AppEnv } from '../middleware';
import { toPaisa } from '../lib/parse';

export const openingRoutes = new Hono<AppEnv>();

openingRoutes.use('*', requireAuth);

/** Everything the opening-balances screen needs to render. */
openingRoutes.get('/', async (c) => {
  const state = await getOpeningState(c.env.DB);
  return c.json(state);
});

const schema = z.object({
  docDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  customers: z
    .array(z.object({ customerId: z.string().min(1), amount: z.number() }))
    .optional(),
  suppliers: z
    .array(z.object({ companyId: z.string().min(1), amount: z.number() }))
    .optional(),
  cash: z
    .array(z.object({ cashAccountId: z.string().min(1), amount: z.number() }))
    .optional(),
  stock: z
    .array(
      z.object({
        productId: z.string().min(1),
        // quantity and per-unit cost in rupees, like every other screen
        qty: z.number(),
        unitCost: z.number().min(0),
      }),
    )
    .optional(),
  notes: z.string().max(500).optional(),
});

/**
 * No `Idempotency-Key` here, unlike every other posting route: an opening may be
 * entered only once per account, so the duplicate-protection the key provides is
 * already structural. A retried request is refused with `opening_already_posted`
 * rather than replayed, which is the honest answer — the books were already told.
 */
openingRoutes.post('/', async (c) => {
  const parsed = schema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json(
      {
        error: 'Invalid opening balances',
        details: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      },
      400,
    );
  }
  const b = parsed.data;

  const result = await postOpeningBalances(c.env.DB, {
    docDate: b.docDate ?? businessDate(),
    customers: b.customers?.map((x) => ({
      customerId: x.customerId,
      amountPaisa: toPaisa(x.amount),
    })),
    suppliers: b.suppliers?.map((x) => ({
      companyId: x.companyId,
      amountPaisa: toPaisa(x.amount),
    })),
    cash: b.cash?.map((x) => ({
      cashAccountId: x.cashAccountId,
      amountPaisa: toPaisa(x.amount),
    })),
    stock: b.stock?.map((x) => ({
      productId: x.productId,
      qtyMilli: Math.round(x.qty * 1000),
      unitCostPaisa: toPaisa(x.unitCost),
    })),
    notes: b.notes,
    userId: c.get('user').id,
  });

  if (!result.ok) {
    return c.json({ error: result.error, code: result.code }, 409);
  }

  return c.json(result, 201);
});
