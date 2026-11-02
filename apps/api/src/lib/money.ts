/**
 * Money handling.
 *
 * Every amount in this system is an INTEGER number of paisa (1 PKR = 100 paisa).
 * SQLite has no decimal type, and floats corrupt ledgers: 0.1 + 0.2 !== 0.3 would
 * show up as a one-paisa gap in a customer balance that nobody can ever explain.
 *
 * Quantities are INTEGER milli-units (1 unit = 1000 milli) so loose fertilizer
 * sold by weight and whole bottles both work off the same column.
 */

export const PAISA_PER_RUPEE = 100;
export const MILLI = 1000;

/** Rs 1,234.50 -> 123450 */
export function rupeesToPaisa(rupees: number | string): number {
  const n = typeof rupees === 'string' ? Number(rupees.trim()) : rupees;
  if (!Number.isFinite(n)) throw new TypeError(`Not a valid amount: ${rupees}`);
  return Math.round(n * PAISA_PER_RUPEE);
}

/** 123450 -> 1234.5 */
export function paisaToRupees(paisa: number): number {
  return paisa / PAISA_PER_RUPEE;
}

/**
 * Format in lakh/crore grouping: 1234567 paisa -> "12,34,567.00"
 * The shop wants 1,23,456 -> lakh/crore style, not Western thousands.
 */
export function formatPkr(paisa: number, opts: { decimals?: boolean; symbol?: boolean } = {}): string {
  const { decimals = true, symbol = true } = opts;
  const negative = paisa < 0;
  const abs = Math.abs(paisa);

  const whole = Math.floor(abs / PAISA_PER_RUPEE).toString();
  const frac = (abs % PAISA_PER_RUPEE).toString().padStart(2, '0');

  // Indian/lakh grouping: last 3 digits, then groups of 2.
  let grouped: string;
  if (whole.length <= 3) {
    grouped = whole;
  } else {
    const last3 = whole.slice(-3);
    const rest = whole.slice(0, -3);
    grouped = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + last3;
  }

  const body = decimals ? `${grouped}.${frac}` : grouped;
  return `${negative ? '-' : ''}${symbol ? 'Rs ' : ''}${body}`;
}

/** Quantity helpers: 2.5 units -> 2500 milli */
export function qtyToMilli(qty: number | string): number {
  const n = typeof qty === 'string' ? Number(qty.trim()) : qty;
  if (!Number.isFinite(n)) throw new TypeError(`Not a valid quantity: ${qty}`);
  return Math.round(n * MILLI);
}

/** 2500 milli -> 2.5 */
export function milliToQty(milli: number): number {
  return milli / MILLI;
}

/** 2500 milli displayed as "2.5" or "2.500" trimmed of trailing zeros */
export function formatQty(milli: number): string {
  const n = milli / MILLI;
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(3)));
}

/**
 * Line total = qty * rate / 1000 - discount, rounded UP-to-a-paisa-deterministic way.
 *
 * Uses integer maths with half-up rounding so the same inputs always produce the
 * same stored total. The result is stored on the line and never recomputed --
 * a reprinted bill must show exactly what the customer saw.
 */
export function lineTotalPaisa(qtyMilli: number, ratePaisa: number, discountPaisa = 0): number {
  const numerator = qtyMilli * ratePaisa;
  const gross = Math.floor((numerator + MILLI / 2) / MILLI); // half-up, no floats
  return gross - discountPaisa;
}

/**
 * Weighted average cost after receiving `inQty` at `inRate`.
 * new_avg = (old_qty * old_avg + in_qty * in_rate) / (old_qty + in_qty)
 * Rounded half-up once, at the end.
 */
export function weightedAvgCostPaisa(
  oldQtyMilli: number,
  oldAvgPaisa: number,
  inQtyMilli: number,
  inRatePaisa: number,
): number {
  const denom = oldQtyMilli + inQtyMilli;
  if (denom <= 0) return inRatePaisa;
  const numerator = oldQtyMilli * oldAvgPaisa + inQtyMilli * inRatePaisa;
  return Math.floor((numerator + denom / 2) / denom);
}
