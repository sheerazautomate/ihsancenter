import { Hono } from 'hono';
import { setCookie, deleteCookie } from 'hono/cookie';
import { z } from 'zod';
import { login, createUser, changePassword, SESSION_COOKIE, SESSION_DAYS } from '../lib/auth';
import { requireAuth, type AppEnv } from '../middleware';

export const authRoutes = new Hono<AppEnv>();

const loginSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(200),
});

authRoutes.post('/login', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Username and password are required' }, 400);
  }

  if (!c.env.SESSION_SECRET) {
    return c.json({ error: 'Server is not configured: SESSION_SECRET is missing' }, 500);
  }

  // Cloudflare sets CF-Connecting-IP; used only for rate limiting, stored hashed.
  const ip = c.req.header('CF-Connecting-IP') ?? c.req.header('X-Forwarded-For') ?? undefined;

  const result = await login(c.env, { ...parsed.data, ip });
  if (!result.ok) return c.json({ error: result.error }, 401);

  setCookie(c, SESSION_COOKIE, result.token, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_DAYS * 86_400,
  });

  return c.json({ user: result.user });
});

authRoutes.post('/logout', (c) => {
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  return c.json({ ok: true });
});

authRoutes.get('/me', requireAuth, (c) => {
  return c.json({ user: c.get('user') });
});

authRoutes.post('/change-password', requireAuth, async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = z
    .object({ currentPassword: z.string().min(1), newPassword: z.string().min(8).max(200) })
    .safeParse(body);

  if (!parsed.success) {
    return c.json({ error: 'New password must be at least 8 characters' }, 400);
  }

  const result = await changePassword(c.env.DB, {
    userId: c.get('user').id,
    ...parsed.data,
  });

  if (!result.ok) return c.json({ error: result.error }, 400);

  // Everything signed in elsewhere is now invalid; this device must sign in again.
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  return c.json({ ok: true, message: 'Password changed. Please sign in again.' });
});

/**
 * Bootstrap the first manager account.
 *
 * Only works while no user exists, so it cannot be abused to add accounts later.
 * Run once after deploying:
 *   curl -X POST https://<api>/auth/bootstrap -d '{"name":"...","username":"...","password":"..."}'
 */
authRoutes.post('/bootstrap', async (c) => {
  const existing = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM users`).first<{ n: number }>();
  if ((existing?.n ?? 0) > 0) {
    return c.json({ error: 'An account already exists' }, 409);
  }

  const parsed = z
    .object({
      name: z.string().min(1).max(100),
      username: z.string().min(3).max(64),
      password: z.string().min(8).max(200),
    })
    .safeParse(await c.req.json().catch(() => null));

  if (!parsed.success) {
    return c.json({ error: 'Name, username and a password of 8+ characters are required' }, 400);
  }

  const created = await createUser(c.env.DB, { ...parsed.data, role: 'manager' });
  return c.json({ ok: true, userId: created.id }, 201);
});
