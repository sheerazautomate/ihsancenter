import type { Context, Next } from 'hono';
import { getCookie } from 'hono/cookie';
import { resolveSession, SESSION_COOKIE, type AuthEnv, type CurrentUser } from './lib/auth';

export interface AppEnv {
  Bindings: AuthEnv & { ALLOWED_ORIGINS?: string };
  Variables: {
    user: CurrentUser;
  };
}

/**
 * Every route except /health and /auth/* sits behind this.
 *
 * The SESSION_SECRET is checked here rather than at import time, so a missing
 * secret produces a clear 500 instead of every request silently failing auth.
 */
export async function requireAuth(c: Context<AppEnv>, next: Next) {
  if (!c.env.SESSION_SECRET) {
    return c.json({ error: 'Server is not configured: SESSION_SECRET is missing' }, 500);
  }

  const token = getCookie(c, SESSION_COOKIE);
  const user = await resolveSession(c.env, token);

  if (!user) {
    return c.json({ error: 'Not signed in' }, 401);
  }

  c.set('user', user);
  await next();
}

/** Role gate. v1 has one manager, but the plumbing exists so a clerk role is a data change. */
export function requireRole(...roles: string[]) {
  return async (c: Context<AppEnv>, next: Next) => {
    const user = c.get('user');
    if (!user || !roles.includes(user.role)) {
      return c.json({ error: 'You do not have permission to do that' }, 403);
    }
    await next();
  };
}
