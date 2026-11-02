/**
 * ID generation.
 *
 * ULIDs are generated in application code rather than by the database, because
 * D1's batch() cannot read an inserted row's id and use it in a later statement
 * of the same batch. Every parent id must already exist when the statement list
 * is built.
 *
 * ULID = 48-bit millisecond timestamp + 80 bits of randomness, Crockford base32.
 * Lexicographically sortable, which makes `ORDER BY id` approximate insertion order.
 */

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32 (no I, L, O, U)

export function ulid(now: number = Date.now()): string {
  let timePart = '';
  let t = now;
  for (let i = 0; i < 10; i++) {
    timePart = ENCODING[t % 32] + timePart;
    t = Math.floor(t / 32);
  }

  const random = new Uint8Array(16);
  crypto.getRandomValues(random);
  let randomPart = '';
  for (let i = 0; i < 16; i++) {
    randomPart += ENCODING[random[i] % 32];
  }
  return timePart + randomPart; // 26 chars
}

/** Prefixed ids keep logs and SQL readable: prod_01J..., inv_01J... */
export function newId(prefix: string, now?: number): string {
  return `${prefix}_${ulid(now)}`;
}

/** A hash of the client request used for idempotency on document posting. */
export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
