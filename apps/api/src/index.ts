import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { authRoutes } from './routes/auth';
import { salesRoutes } from './routes/sales';
import { catalogRoutes } from './routes/catalog';
import { customerRoutes } from './routes/customers';
import type { AppEnv } from './middleware';

const app = new Hono<AppEnv>();

/**
 * CORS: the SPA is served from Cloudflare Pages (a different origin), so the
 * browser needs credentials to be allowed explicitly. No wildcard origin is
 * possible when cookies are involved -- the exact origin must be echoed.
 */
app.use(
  '/api/*',
  cors({
    origin: (origin, c) => {
      const allowed = (c.env.ALLOWED_ORIGINS ?? '')
        .split(',')
        .map((o: string) => o.trim())
        .filter(Boolean);
      // Local dev origins are always allowed so the SPA can run beside the API.
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
  fetch: app.fetch,
};
