/**
 * Formatting. Mirrors apps/api/src/lib/money.ts exactly -- the shop asked for
 * lakh/crore grouping (Rs 12,34,567), not Western thousands.
 */

const PAISA_PER_RUPEE = 100;

export function formatPkr(paisa: number, opts: { decimals?: boolean; symbol?: boolean } = {}): string {
  const { decimals = true, symbol = true } = opts;
  const negative = paisa < 0;
  const abs = Math.abs(Math.round(paisa));

  const whole = Math.floor(abs / PAISA_PER_RUPEE).toString();
  const frac = (abs % PAISA_PER_RUPEE).toString().padStart(2, '0');

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

/** Shows whole rupees in inputs, e.g. 123450 -> "1234.50" */
export function paisaToInput(paisa: number): string {
  return (paisa / PAISA_PER_RUPEE).toFixed(2);
}

export function formatQty(milli: number): string {
  const n = milli / 1000;
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(3)));
}

export function parseNumber(value: string, fallback = 0): number {
  const n = Number(value.replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : fallback;
}
