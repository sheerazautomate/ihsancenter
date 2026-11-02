/**
 * Document numbering.
 *
 * Numbers are allocated with a single atomic UPDATE ... RETURNING *before* the
 * document batch is built, because a batch cannot read a value and reuse it.
 *
 * Consequence: a failed batch burns one number, leaving a gap. Gaps are honest
 * and are surfaced in a report rather than hidden. Deriving numbers from row ids
 * was rejected: it hides real failures and produces unreadable invoice numbers.
 */

export type DocType = 'invoice' | 'purchase' | 'sale_return' | 'purchase_return' | 'receipt' | 'payment';

const PREFIXES: Record<DocType, string> = {
  invoice: 'INV',
  purchase: 'PUR',
  sale_return: 'SR',
  purchase_return: 'PR',
  receipt: 'REC',
  payment: 'PAY',
};

export const DOC_PREFIXES = PREFIXES;

/** The shop's business date, `YYYY-MM-DD`, in Asia/Karachi. */
export function businessDate(d: Date = new Date()): string {
  // en-CA yields YYYY-MM-DD; the zone is fixed to the shop's timezone so that
  // a sale at 11pm local lands on the shop's today, not UTC's tomorrow.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Karachi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

export function businessYear(docDate: string): number {
  return Number(docDate.slice(0, 4));
}

/** `INV-2026-00042` */
export function formatDocNo(docType: DocType, year: number, seq: number): string {
  return `${PREFIXES[docType]}-${year}-${String(seq).padStart(5, '0')}`;
}

/**
 * Allocate the next document number. Runs BEFORE the posting batch.
 * Returns the formatted number, e.g. INV-2026-00042.
 */
export async function allocateDocNo(
  db: D1Database,
  docType: DocType,
  docDate: string,
): Promise<{ docNo: string; seq: number; year: number }> {
  const year = businessYear(docDate);

  // Create the counter row if this is the first document of the year.
  await db
    .prepare(`INSERT OR IGNORE INTO doc_sequences (doc_type, year, next_no) VALUES (?, ?, 1)`)
    .bind(docType, year)
    .run();

  // Atomic increment-and-read. RETURNING gives us the value we just consumed.
  const row = await db
    .prepare(
      `UPDATE doc_sequences SET next_no = next_no + 1
       WHERE doc_type = ? AND year = ?
       RETURNING next_no - 1 AS seq`,
    )
    .bind(docType, year)
    .first<{ seq: number }>();

  if (!row) throw new Error(`Could not allocate a ${docType} number for ${year}`);
  return { docNo: formatDocNo(docType, year, row.seq), seq: row.seq, year };
}
