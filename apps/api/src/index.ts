import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { authRoutes } from './routes/auth';
import { salesRoutes } from './routes/sales';
import { catalogRoutes } from './routes/catalog';
import { customerRoutes } from './routes/customers';
import { purchaseRoutes } from './routes/purchases';
import { moneyRoutes } from './routes/money';
import { reportRoutes } from './routes/reports';
import type { AppEnv } from './middleware';

interface Env {
  DB: D1Database;
  SESSION_SECRET: string;
  ENVIRONMENT: string;
  ALLOWED_ORIGINS?: string;
  /** Present only when the Worker also serves the built SPA. */
  ASSETS?: Fetcher;
}

const app = new Hono<AppEnv>();

/**
 * CORS.
 *
 * In production the SPA is served BY this Worker, so the browser only ever sees one
 * origin and no CORS is needed at all. The allowlist exists for two other cases:
 * a Vite dev server on another port, and anyone who chooses to host the SPA
 * separately on Cloudflare Pages.
 *
 * A wildcard is impossible here: cookies are involved, so the exact origin must be
 * echoed back.
 */
app.use(
  '/api/*',
  cors({
    origin: (origin, c) => {
      // Same-origin requests send no Origin header, or send our own host.
      if (!origin) return null;

      const allowed = (c.env.ALLOWED_ORIGINS ?? '')
        .split(',')
        .map((o: string) => o.trim())
        .filter(Boolean);

      const isLocal = /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin);
      if (isLocal || allowed.includes(origin)) return origin;
      return null;
    },
    credentials: true,
    allowHeaders: ['Content-Type', 'Idempotency-Key'],
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    maxAge: 86400,
  }),
);

app.get('/health', (c) => c.json({ ok: true, service: 'ihsancenter-api' }));

app.route('/api/auth', authRoutes);
app.route('/api/sales', salesRoutes);
app.route('/api/catalog', catalogRoutes);
app.route('/api/customers', customerRoutes);
app.route('/api/purchases', purchaseRoutes);
app.route('/api/money', moneyRoutes);
app.route('/api/reports', reportRoutes);

/**
 * Unmatched requests. When the Worker serves the SPA, Cloudflare's static asset
 * handler answers unmatched GETs with index.html (see `not_found_handling` in
 * wrangler.toml), so client-side routes survive a hard refresh. Anything arriving
 * here is an unknown API path or a non-GET on a static path.
 */
app.notFound((c) => c.json({ error: 'Not found' }, 404));

/**
 * Never leak a stack trace to the client: it can disclose schema details. The
 * error is logged for the operator instead.
 */
app.onError((err, c) => {
  console.error('Unhandled error:', err);
  return c.json({ error: 'Something went wrong. Please try again.' }, 500);
});

export default {
  /**
   * Request router.
   *
   * /api/* and /health go to Hono. Everything else is a static asset. When the
   * requested asset does not exist (e.g. /receivables, a client-side route that is
   * only known to React Router), index.html is returned so a hard refresh or a
   * bookmarked link still lands on the app rather than a 404.
   *
   * In tests ASSETS is absent, so requests fall through to Hono unchanged.
   */
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const isApi = url.pathname.startsWith('/api/') || url.pathname === '/health';

    if (!isApi && env.ASSETS) {
      const asset = await env.ASSETS.fetch(request);
      if (asset.status !== 404) return asset;

      // SPA fallback
      const indexUrl = new URL('/', url);
      return env.ASSETS.fetch(new Request(indexUrl.toString(), request));
    }

    return app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
