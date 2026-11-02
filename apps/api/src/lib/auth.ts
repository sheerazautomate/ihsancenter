/**
 * Authentication.
 *
 * One manager account in practice, but modelled as a users table with a role
 * column so adding a cashier later is a data change rather than a migration.
 *
 * Sessions are HMAC-signed cookies (HttpOnly, Secure, SameSite=Lax). No session
 * table: the token carries the user id, role and token_version, so bumping
 * token_version invalidates every existing session instantly (used on password
 * change).
 */

import {
  hashPassword,
  verifyPassword,
  signSession,
  verifySession,
  type SessionPayload,
} from './crypto';
import { newId, sha256Hex } from './ids';

export const SESSION_COOKIE = 'ihsan_session';
export const SESSION_DAYS = 30; // the manager logs in once per device, not daily

export interface UserRow {
  id: string;
  name: string;
  username: string;
  password_hash: string;
  iterations: number;
  token_version: number;
  role: string;
  is_active: number;
}

export interface AuthEnv {
  DB: D1Database;
  SESSION_SECRET: string;
  ALLOWED_ORIGINS?: string;
}

// ---------- brute-force protection ----------

const MAX_FAILED_ATTEMPTS = 5;
const WINDOW_MINUTES = 15;
/** Fixed delay so a failed login cannot be used to probe usernames by timing. */
const FAILED_LOGIN_DELAY_MS = 700;

export async function isLockedOut(
  db: D1Database,
  username: string,
  ipHash: string | null,
): Promise<boolean> {
  const since = new Date(Date.now() - WINDOW_MINUTES * 60_000).toISOString();
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM login_attempts
       WHERE username = ? AND succeeded = 0 AND at > ?
         AND (? IS NULL OR ip_hash = ?)`,
    )
    .bind(username, since, ipHash, ipHash)
    .first<{ n: number }>();
  return (row?.n ?? 0) >= MAX_FAILED_ATTEMPTS;
}

async function recordAttempt(
  db: D1Database,
  username: string,
  ipHash: string | null,
  succeeded: boolean,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO login_attempts (id, at, username, ip_hash, succeeded) VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(newId('la'), new Date().toISOString(), username, ipHash, succeeded ? 1 : 0)
    .run();
}

/** Hash an IP so the log holds no raw addresses. */
export async function hashIp(ip: string): Promise<string> {
  return sha256Hex(`ihsan:${ip}`);
}

// ---------- login / logout ----------

export type LoginResult =
  | { ok: true; token: string; user: { id: string; name: string; role: string } }
  | { ok: false; error: string };

export async function login(
  env: AuthEnv,
  args: { username: string; password: string; ip?: string },
): Promise<LoginResult> {
  const username = args.username.trim().toLowerCase();
  const ipHash = args.ip ? await hashIp(args.ip) : null;

  if (await isLockedOut(env.DB, username, ipHash)) {
    await new Promise((r) => setTimeout(r, FAILED_LOGIN_DELAY_MS));
    return {
      ok: false,
      error: `Too many failed attempts. Try again in ${WINDOW_MINUTES} minutes.`,
    };
  }

  const user = await env.DB.prepare(`SELECT * FROM users WHERE username = ? AND is_active = 1`)
    .bind(username)
    .first<UserRow>();

  // Same delay and same message whether the user is missing or the password is
  // wrong, so this cannot be used to enumerate accounts.
  if (!user) {
    await new Promise((r) => setTimeout(r, FAILED_LOGIN_DELAY_MS));
    await recordAttempt(env.DB, username, ipHash, false);
    return { ok: false, error: 'Invalid username or password' };
  }

  const valid = await verifyPassword(args.password, user.password_hash, user.iterations);
  if (!valid) {
    await new Promise((r) => setTimeout(r, FAILED_LOGIN_DELAY_MS));
    await recordAttempt(env.DB, username, ipHash, false);
    return { ok: false, error: 'Invalid username or password' };
  }

  await recordAttempt(env.DB, username, ipHash, true);
  await env.DB.prepare(`UPDATE users SET last_login_at = ? WHERE id = ?`)
    .bind(new Date().toISOString(), user.id)
    .run();

  const token = await signSession(
    {
      sub: user.id,
      role: user.role,
      ver: user.token_version,
      exp: Math.floor(Date.now() / 1000) + SESSION_DAYS * 86_400,
    },
    env.SESSION_SECRET,
  );

  return { ok: true, token, user: { id: user.id, name: user.name, role: user.role } };
}

export interface CurrentUser {
  id: string;
  name: string;
  role: string;
}

/** Resolve a session cookie to a live user, or null. */
export async function resolveSession(
  env: AuthEnv,
  token: string | undefined,
): Promise<CurrentUser | null> {
  if (!token) return null;

  const payload = await verifySession(token, env.SESSION_SECRET);
  if (!payload) return null;

  const user = await env.DB.prepare(
    `SELECT id, name, role, token_version, is_active FROM users WHERE id = ?`,
  )
    .bind(payload.sub)
    .first<{ id: string; name: string; role: string; token_version: number; is_active: number }>();

  if (!user || user.is_active !== 1) return null;
  // A password change bumps token_version, invalidating old cookies immediately.
  if (user.token_version !== payload.ver) return null;

  return { id: user.id, name: user.name, role: user.role };
}

export async function createUser(
  db: D1Database,
  args: { name: string; username: string; password: string; role?: string },
): Promise<{ id: string }> {
  if (args.password.length < 8) {
    throw new Error('Password must be at least 8 characters');
  }
  const { hash, iterations } = await hashPassword(args.password);

  const id = newId('usr');
  await db
    .prepare(
      `INSERT INTO users (id, name, username, password_hash, iterations, role, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      args.name,
      args.username.trim().toLowerCase(),
      hash,
      iterations,
      args.role ?? 'manager',
      new Date().toISOString(),
    )
    .run();

  return { id };
}

export async function changePassword(
  db: D1Database,
  args: { userId: string; currentPassword: string; newPassword: string },
): Promise<{ ok: boolean; error?: string }> {
  const user = await db.prepare(`SELECT * FROM users WHERE id = ?`).bind(args.userId).first<UserRow>();
  if (!user) return { ok: false, error: 'User not found' };

  const valid = await verifyPassword(args.currentPassword, user.password_hash, user.iterations);
  if (!valid) return { ok: false, error: 'Current password is incorrect' };
  if (args.newPassword.length < 8) {
    return { ok: false, error: 'New password must be at least 8 characters' };
  }

  const { hash, iterations } = await hashPassword(args.newPassword);
  await db
    .prepare(
      `UPDATE users SET password_hash = ?, iterations = ?, token_version = token_version + 1
       WHERE id = ?`,
    )
    .bind(hash, iterations, args.userId)
    .run();

  return { ok: true };
}
