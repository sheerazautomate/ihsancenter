/**
 * API client.
 *
 * Vitest-free, dependency-free. Every request goes to `/api/...` on the same
 * origin: in development Vite proxies to `wrangler dev`, in production Pages
 * proxies to the Worker. Keeping it same-origin is why session cookies work
 * without any CORS or SameSite games.
 */

export class ApiError extends Error {
  code?: string;
  status: number;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export async function api<T>(
  path: string,
  options: RequestInit & { idempotencyKey?: string } = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body) headers.set('Content-Type', 'application/json');
  if (options.idempotencyKey) headers.set('Idempotency-Key', options.idempotencyKey);

  const res = await fetch(path.startsWith('/') ? path : `/api${path}`, {
    ...options,
    headers,
    credentials: 'include',
  });

  const text = await res.text();
  const body = text ? JSON.parse(text) : {};

  if (!res.ok) {
    throw new ApiError(body.error ?? `Request failed (${res.status})`, res.status, body.code);
  }
  return body as T;
}

// ---------- shared shapes (mirrors of the API responses) ----------

export interface Product {
  id: string;
  name: string;
  sku: string | null;
  barcode: string | null;
  category: string;
  unit: string;
  pack_size: string | null;
  sale_rate_paisa: number;
  purchase_rate_paisa: number;
  qty_on_hand_milli: number;
  reorder_level_milli: number;
  company_id: string;
  company_name: string;
}

export interface Customer {
  id: string;
  name: string;
  phone: string | null;
  village: string | null;
  type: string;
  credit_limit_paisa: number;
  is_credit_hold: number;
  outstanding_paisa: number;
}

export interface CreditPanel {
  customerId: string;
  name: string;
  creditLimitPaisa: number;
  outstandingPaisa: number;
  availablePaisa: number | null;
  isCreditHold: boolean;
  hasLimit: boolean;
  wouldExceed: boolean;
  aging: { d0to30: number; d31to60: number; d61to90: number; d90plus: number };
}

export interface InvoiceLine {
  id: string;
  product_id: string;
  qty_milli: number;
  rate_paisa: number;
  discount_paisa: number;
  line_total_paisa: number;
  product_name?: string;
  unit?: string;
  pack_size?: string | null;
}

export interface Invoice {
  id: string;
  invoice_no: string;
  doc_date: string;
  customer_id: string;
  customer_name?: string;
  customer_phone?: string | null;
  customer_village?: string | null;
  subtotal_paisa: number;
  discount_paisa: number;
  total_paisa: number;
  paid_cash_paisa: number;
  paid_bank_paisa: number;
  credit_paisa: number;
  status: string;
  created_at: string;
}

export interface PostedSale {
  id: string;
  invoiceNo: string;
  totalPaisa: number;
  creditPaisa: number;
  costTotalPaisa: number;
}
