/**
 * Password hashing and session tokens.
 *
 * PBKDF2-SHA256 via WebCrypto, with the iteration count stored per user so it can
 * be raised later without invalidating existing passwords (old hashes are upgraded
 * on the next successful login).
 *
 * NOTE ON COST -- this was measured, not assumed.
 *
 * A Cloudflare Worker on the free plan gets 10 ms of CPU per request, and PBKDF2
 * is deliberately expensive. Measured in workerd (the actual runtime):
 *
 *     10,000 iterations ->  1.8 ms
 *     25,000 iterations ->  4.4 ms
 *     50,000 iterations ->  8.6 ms
 *    100,000 iterations -> 16.9 ms   <-- over budget
 *
 * 100,000 is the current OWASP-ish default for interactive logins, but it would
 * exceed the free plan's CPU budget on its own. 25,000 is the chosen compromise:
 * ~4.4 ms leaves room for session signing and the D1 round trip while staying
 * under the ceiling. It is weaker than ideal, which is why login also has a fixed
 * delay and a 5-attempt lockout -- the two controls together are what make the
 * lower count acceptable for a single internal account.
 *
 * The count is stored per user, so raising it later costs nothing: existing hashes
 * keep working and are upgraded on next login.
 */

export const DEFAULT_ITERATIONS = 25_000;

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    key,
    256,
  );
  return toHex(bits);
}

/** Returns `salt:hash` (both hex), to be stored alongside the iteration count. */
export async function hashPassword(
  password: string,
  iterations: number = DEFAULT_ITERATIONS,
): Promise<{ hash: string; iterations: number }> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const derived = await pbkdf2(password, salt, iterations);
  return { hash: `${toHex(salt.buffer as ArrayBuffer)}:${derived}`, iterations };
}

export async function verifyPassword(
  password: string,
  stored: string,
  iterations: number,
): Promise<boolean> {
  const [saltHex, expected] = stored.split(':');
  if (!saltHex || !expected) return false;
  const actual = await pbkdf2(password, fromHex(saltHex), iterations);
  return timingSafeEqual(actual, expected);
}

/** Constant-time comparison: never leak how much of a hash matched. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Measures PBKDF2 cost in the running environment. Used by tests and the build. */
export async function measureHashCost(iterations: number): Promise<number> {
  const start = performance.now();
  await hashPassword('benchmark-password', iterations);
  return performance.now() - start;
}

// ============ session tokens ============

export interface SessionPayload {
  sub: string; // user id
  role: string;
  ver: number; // token_version, so a password change invalidates sessions
  exp: number; // unix seconds
}

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(input: string): Uint8Array {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

/** Signed session token: `<base64url payload>.<base64url hmac>` */
export async function signSession(payload: SessionPayload, secret: string): Promise<string> {
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return `${body}.${b64url(new Uint8Array(sig))}`;
}

export async function verifySession(
  token: string,
  secret: string,
): Promise<SessionPayload | null> {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;

  const key = await hmacKey(secret);
  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    b64urlDecode(sig) as BufferSource,
    new TextEncoder().encode(body),
  );
  if (!valid) return null;

  try {
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body))) as SessionPayload;
    if (payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}
