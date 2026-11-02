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

/**
 * Resolve a client path to a URL on the API.
 *
 * Callers pass bare paths (`/auth/login`, `/catalog/stock`) because the API is
 * same-origin in every environment: Vite proxies `/api` in dev, and the Worker
 * serves the built SPA itself in production. The prefix is therefore added here,
 * in one place.
 *
 * A previous version read `path.startsWith('/') ? path : '/api' + path`, which
 * meant the prefix was never applied -- every caller starts with a slash. That
 * shipped silently because in dev a request to `/auth/login` simply 404s against
 * the Vite server, while in production it reaches the static-asset handler and
 * comes back as a 405 (POST) or as index.html (GET), which the app then read as
 * "not signed in". One function, one rule, and `absoluteUrl()` below keeps
 * genuinely external URLs working.
 */
export function apiUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  // Already an API path (`/api` or `/api/...`)? Leave it alone rather than
  // producing /api/api. Note this is anchored, so /catalog/apiary still gets the
  // prefix.
  if (/^\/api(\/|$)/.test(path)) return path;
  return `/api${path.startsWith('/') ? path : `/${path}`}`;
}

export async function api<T>(
  path: string,
  options: RequestInit & { idempotencyKey?: string } = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body) headers.set('Content-Type', 'application/json');
  if (options.idempotencyKey) headers.set('Idempotency-Key', options.idempotencyKey);

  const res = await fetch(apiUrl(path), {
    ...options,
    headers,
    credentials: 'include',
  });

  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    // The API only ever returns JSON. Anything else means the request reached the
    // static-asset handler instead -- in a single-origin deploy, a missing /api
    // prefix gets index.html back with a 200, and the failure then looks like a
    // signed-out user rather than a wrong URL. Say what actually happened.
    throw new ApiError(
      `Expected JSON from ${apiUrl(path)} but got ${res.status} ${
        res.headers.get('content-type') ?? 'no content-type'
      }. This usually means the request missed the API prefix.`,
      res.status,
    );
  }

  if (!res.ok) {
    throw new ApiError(
      (body.error as string) ?? `Request failed (${res.status})`,
      res.status,
      body.code as string | undefined,
    );
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
  is_active?: number;
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

/** What has been received against an invoice since it was issued. */
export interface InvoicePayment {
  settledPaisa: number;
  outstandingPaisa: number;
  overpaidPaisa: number;
  receipts: { receipt_no: string; doc_date: string; mode: string; amount_paisa: number }[];
}

export interface PostedSale {
  id: string;
  invoiceNo: string;
  totalPaisa: number;
  creditPaisa: number;
  costTotalPaisa: number;
}

// ---------- additional shapes ----------

/** Fixed set from the schema CHECK constraint on products.category. */
export type ProductCategory =
  | 'insecticide'
  | 'fungicide'
  | 'herbicide'
  | 'fertilizer'
  | 'seed'
  | 'other';

export interface Company {
  id: string;
  name: string;
  contact_person: string | null;
  phone: string | null;
}

export interface CashAccount {
  id: string;
  name: string;
  type: 'cash' | 'bank';
  bank_name: string | null;
  account_no: string | null;
}

export interface ExpenseCategory {
  id: string;
  name: string;
}

export interface CompanyTotals {
  companyId: string;
  name: string;
  purchasesPaisa: number;
  salesPaisa: number;
  costPaisa: number;
  grossProfitPaisa: number;
  payablePaisa: number;
}

export interface Dashboard {
  date: string;
  today: {
    salesPaisa: number;
    collectedPaisa: number;
    creditGivenPaisa: number;
    expensesPaisa: number;
    receiptsPaisa: number;
    invoiceCount: number;
  } | null;
  month: {
    salesPaisa: number;
    collectedPaisa: number;
    creditGivenPaisa: number;
    expensesPaisa: number;
    receiptsPaisa: number;
    invoiceCount: number;
  } | null;
  monthFrom: string;
  profit: {
    revenuePaisa: number;
    cogsPaisa: number;
    grossProfitPaisa: number;
    expensesPaisa: number;
    netProfitPaisa: number;
  };
  cash: { id: string; name: string; type: string; balancePaisa: number }[];
  companies: CompanyTotals[];
  totalReceivablePaisa: number;
  lowStockCount: number;
}

export interface ReceivableRow {
  customerId: string;
  name: string;
  phone: string | null;
  village: string | null;
  creditLimitPaisa: number;
  isCreditHold: number;
  /** Ledger balance: the authoritative figure. */
  totalPaisa: number;
  d0to30: number;
  d31to60: number;
  d61to90: number;
  d90plus: number;
  /** Balance not attributable to any invoice (opening balance or advance). */
  unappliedPaisa: number;
}

export interface UnpaidInvoice {
  id: string;
  invoice_no: string;
  doc_date: string;
  total_paisa: number;
  credit_paisa: number;
  bal: number;
}

// ---------- opening balances ----------

export interface OpeningState {
  posted: boolean;
  firstOpeningDate: string | null;
  customers: { id: string; name: string; phone: string | null; amountPaisa: number }[];
  suppliers: { id: string; name: string; amountPaisa: number }[];
  cash: { id: string; name: string; type: string; amountPaisa: number }[];
  stock: {
    id: string;
    name: string;
    companyName: string;
    qtyMilli: number;
    unitCostPaisa: number;
  }[];
  totals: {
    receivablePaisa: number;
    payablePaisa: number;
    cashPaisa: number;
    inventoryPaisa: number;
  };
}

export interface OpeningInput {
  docDate: string;
  customers?: { customerId: string; amount: number }[];
  suppliers?: { companyId: string; amount: number }[];
  cash?: { cashAccountId: string; amount: number }[];
  stock?: { productId: string; qty: number; unitCost: number }[];
  notes?: string;
}

export interface OpeningResult {
  ok: true;
  posted: { customers: number; suppliers: number; cash: number; stock: number };
  totals: {
    receivablePaisa: number;
    cashPaisa: number;
    inventoryPaisa: number;
    payablePaisa: number;
    capitalPaisa: number;
  };
}
