/**
 * Idempotent document posting.
 *
 * The problem: a shopkeeper double-taps "Save bill" on a slow phone. Two requests
 * arrive. Without protection that is two invoices, two stock deductions, and a
 * customer who owes double what the screen said.
 *
 * The naive fix -- "look up the key, and if absent, insert" -- has a race window
 * between the read and the write. On a single till it will almost never fire, which
 * is exactly what makes it the worst kind of bug: untestable in practice, ruinous
 * when it happens.
 *
 * Instead the key is a UNIQUE column on the document itself. The second insert
 * violates the unique index and the whole batch rolls back atomically. There is no
 * window at all, because the database enforces it rather than the application.
 *
 * On a genuine retry (the first request committed but the response was lost) we
 * look the document up by key and return the original, so the caller sees the same
 * invoice number twice instead of an error.
 */

export const IDEMPOTENCY_HEADER = 'Idempotency-Key';

export interface IdempotencyOutcome<T> {
  /** True when this request found and returned an ALREADY POSTED document. */
  replayed: boolean;
  result: T;
}

/** Keys are client-supplied; constrain them so they cannot be used to bloat the row. */
export function normaliseIdempotencyKey(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const key = raw.trim();
  if (key.length === 0) return null;
  if (key.length > 100) throw new Error('Idempotency key is too long (max 100 characters)');
  if (!/^[A-Za-z0-9_.:-]+$/.test(key)) {
    throw new Error('Idempotency key may only contain letters, digits, and _ . : -');
  }
  return key;
}

/**
 * True when a batch failure was caused by our unique idempotency index rather
 * than a business guard. SQLite names the index in the error, which is what makes
 * this distinguishable.
 */
export function isIdempotencyCollision(err: unknown, indexName: string): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes('UNIQUE constraint failed') &&
    (message.includes(indexName) || message.includes('idempotency_key'))
  );
}
