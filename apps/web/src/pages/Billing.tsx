import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError, type CreditPanel as CreditPanelData, type Customer, type Invoice, type Product } from '../lib/api';
import { formatPkr, formatQty, parseNumber, paisaToInput } from '../lib/money';
import CreditPanel from '../components/CreditPanel';
import Receipt from '../components/Receipt';

interface BillLine {
  key: string;
  productId: string;
  name: string;
  unit: string;
  qty: number;
  rate: number; // rupees
  discount: number; // rupees, per line
  stockMilli: number;
}

let lineCounter = 0;

export default function BillingPage() {
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [customerQuery, setCustomerQuery] = useState('');
  const [productQuery, setProductQuery] = useState('');
  const [lines, setLines] = useState<BillLine[]>([]);
  const [invoiceDiscount, setInvoiceDiscount] = useState(0);
  const [paidCash, setPaidCash] = useState('');
  const [paidBank, setPaidBank] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [posted, setPosted] = useState<Invoice | null>(null);
  const [newCustomerName, setNewCustomerName] = useState('');
  const [showNewCustomer, setShowNewCustomer] = useState(false);

  /**
   * The idempotency key is created ONCE per bill and reused on every retry.
   * That is what makes a double-tap on a slow connection safe: the second request
   * carries the same key, so the server returns the first invoice instead of
   * creating a second one.
   */
  const idempotencyKey = useRef<string>(crypto.randomUUID());

  const customerSearch = useQuery({
    queryKey: ['customers', customerQuery],
    queryFn: () =>
      api<{ customers: Customer[] }>(`/customers?q=${encodeURIComponent(customerQuery)}&limit=8`),
    enabled: customerQuery.length > 0,
  });

  const productSearch = useQuery({
    queryKey: ['products', productQuery],
    queryFn: () =>
      api<{ products: Product[] }>(`/catalog/products?q=${encodeURIComponent(productQuery)}&limit=10`),
    enabled: productQuery.length > 0,
  });

  const credit = useQuery({
    queryKey: ['credit', customer?.id],
    queryFn: () => api<{ credit: CreditPanelData }>(`/sales/credit/${customer!.id}`),
    enabled: !!customer,
  });

  // ---------- totals ----------
  const totals = useMemo(() => {
    const subtotal = lines.reduce(
      (sum, l) => sum + Math.round(l.qty * 1000 * Math.round(l.rate * 100) / 1000) - Math.round(l.discount * 100),
      0,
    );
    const total = Math.max(0, subtotal - Math.round(invoiceDiscount * 100));
    const cash = Math.round(parseNumber(paidCash) * 100);
    const bank = Math.round(parseNumber(paidBank) * 100);
    const creditAmount = Math.max(0, total - cash - bank);
    return { subtotal, total, cash, bank, creditAmount };
  }, [lines, invoiceDiscount, paidCash, paidBank]);

  function addProduct(p: Product) {
    setLines((prev) => {
      const existing = prev.findIndex((l) => l.productId === p.id && l.discount === 0);
      if (existing >= 0) {
        const copy = [...prev];
        copy[existing] = { ...copy[existing], qty: copy[existing].qty + 1 };
        return copy;
      }
      return [
        ...prev,
        {
          key: `line-${++lineCounter}`,
          productId: p.id,
          name: p.name,
          unit: p.pack_size ? `${p.pack_size}` : p.unit,
          qty: 1,
          rate: p.sale_rate_paisa / 100,
          discount: 0,
          stockMilli: p.qty_on_hand_milli,
        },
      ];
    });
    setProductQuery('');
    setError(null);
  }

  function updateLine(key: string, patch: Partial<BillLine>) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  function removeLine(key: string) {
    setLines((prev) => prev.filter((l) => l.key !== key));
  }

  function resetBill() {
    setLines([]);
    setInvoiceDiscount(0);
    setPaidCash('');
    setPaidBank('');
    setNotes('');
    setCustomer(null);
    setCustomerQuery('');
    setError(null);
    idempotencyKey.current = crypto.randomUUID();
  }

  async function createCustomer() {
    if (!newCustomerName.trim()) return;
    try {
      const { id } = await api<{ id: string }>('/customers', {
        method: 'POST',
        body: JSON.stringify({ name: newCustomerName.trim() }),
      });
      setCustomer({
        id,
        name: newCustomerName.trim(),
        phone: null,
        village: null,
        type: 'farmer',
        credit_limit_paisa: 0,
        is_credit_hold: 0,
        outstanding_paisa: 0,
      });
      setNewCustomerName('');
      setShowNewCustomer(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not add customer');
    }
  }

  async function saveBill(overrides?: { overrideCredit: boolean; overrideReason: string }) {
    if (!customer) return setError('Select a customer first');
    if (lines.length === 0) return setError('Add at least one product');

    setBusy(true);
    setError(null);
    try {
      const body = {
        customerId: customer.id,
        lines: lines.map((l) => ({
          productId: l.productId,
          qty: l.qty,
          rate: l.rate,
          discount: l.discount || undefined,
        })),
        invoiceDiscount: invoiceDiscount || undefined,
        paidCash: parseNumber(paidCash) || undefined,
        paidBank: parseNumber(paidBank) || undefined,
        cashAccountId: parseNumber(paidCash) > 0 ? 'ca_counter' : undefined,
        bankAccountId: parseNumber(paidBank) > 0 ? 'ca_bank' : undefined,
        notes: notes || undefined,
        overrideCredit: overrides?.overrideCredit,
        overrideReason: overrides?.overrideReason,
      };

      const res = await api<{ sale: { id: string }; replayed: boolean }>('/sales', {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey.current },
        body: JSON.stringify(body),
      });

      const invoice = await api<{ invoice: Invoice; lines: unknown[] }>(`/sales/${res.sale.id}`);
      setPosted(invoice.invoice);
      setLines([]);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'credit_limit_exceeded') {
        const reason = window.prompt(
          `${err.message}\n\nOverride reason (recorded in the audit log):`,
        );
        if (reason && reason.trim().length > 2) {
          setBusy(false);
          return saveBill({ overrideCredit: true, overrideReason: reason.trim() });
        }
        setError('Sale blocked: credit limit would be exceeded.');
      } else if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError('Could not save the bill');
      }
    } finally {
      setBusy(false);
    }
  }

  if (posted) {
    return (
      <div>
        <div className="no-print" style={{ maxWidth: 420, margin: '0 auto 12px' }}>
          <div className="alert success">Invoice {posted.invoice_no} saved.</div>
          <div className="row" style={{ marginBottom: 12 }}>
            <button className="btn grow" onClick={() => { setPosted(null); resetBill(); }}>
              New bill
            </button>
            <button className="btn secondary" onClick={() => window.print()}>
              Print
            </button>
          </div>
        </div>
        <Receipt invoice={posted} lines={[]} />
      </div>
    );
  }

  return (
    <div className="billing">
      {/* ---------------- left: customer + products + lines ---------------- */}
      <div>
        <div className="card">
          <h2>Customer</h2>
          {customer ? (
            <div className="row">
              <div className="grow">
                <strong>{customer.name}</strong>
                <div className="muted">
                  {[customer.phone, customer.village].filter(Boolean).join(' · ') || 'No phone on file'}
                </div>
              </div>
              <button className="btn secondary sm" onClick={() => setCustomer(null)}>
                Change
              </button>
            </div>
          ) : (
            <>
              <input
                className="input"
                placeholder="Search customer by name, phone or village…"
                value={customerQuery}
                onChange={(e) => setCustomerQuery(e.target.value)}
                autoFocus
              />
              {customerSearch.data && customerQuery && (
                <div className="search-results">
                  {customerSearch.data.customers.map((c) => (
                    <div
                      key={c.id}
                      className="search-item"
                      onClick={() => {
                        setCustomer(c);
                        setCustomerQuery('');
                      }}
                    >
                      <div>
                        <div className="name">{c.name}</div>
                        <div className="meta">
                          {[c.phone, c.village].filter(Boolean).join(' · ') || c.type}
                        </div>
                      </div>
                      {c.outstanding_paisa > 0 && (
                        <span className="badge credit">
                          owes {formatPkr(c.outstanding_paisa, { decimals: false })}
                        </span>
                      )}
                    </div>
                  ))}
                  {customerSearch.data.customers.length === 0 && (
                    <div className="search-item" onClick={() => setShowNewCustomer(true)}>
                      <div>
                        <div className="name">Add “{customerQuery}” as a new customer</div>
                        <div className="meta">Name only — phone can be added later</div>
                      </div>
                    </div>
                  )}
                </div>
              )}
              {showNewCustomer && (
                <div className="row" style={{ marginTop: 8 }}>
                  <input
                    className="input grow"
                    placeholder="New customer name"
                    value={newCustomerName}
                    onChange={(e) => setNewCustomerName(e.target.value)}
                  />
                  <button className="btn sm" onClick={createCustomer}>
                    Add
                  </button>
                </div>
              )}
            </>
          )}
        </div>

        <div className="card">
          <h2>Products</h2>
          <input
            className="input"
            placeholder="Scan barcode or search product…"
            value={productQuery}
            onChange={(e) => setProductQuery(e.target.value)}
          />
          {productSearch.data && productQuery && (
            <div className="search-results">
              {productSearch.data.products.map((p) => (
                <div key={p.id} className="search-item" onClick={() => addProduct(p)}>
                  <div>
                    <div className="name">{p.name}</div>
                    <div className="meta">
                      {p.company_name} · {p.pack_size ?? p.unit} · {p.category}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div className="mono">{formatPkr(p.sale_rate_paisa, { decimals: false })}</div>
                    <div className={`meta ${p.qty_on_hand_milli <= 0 ? 'stock-out' : ''}`}>
                      {p.qty_on_hand_milli <= 0
                        ? 'Out of stock'
                        : `${formatQty(p.qty_on_hand_milli)} in stock`}
                    </div>
                  </div>
                </div>
              ))}
              {productSearch.data.products.length === 0 && (
                <div className="search-item">
                  <div className="meta">No product matches “{productQuery}”</div>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="card">
          <h2>Items</h2>
          {lines.length === 0 ? (
            <p className="muted">No items yet. Search a product above.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Product</th>
                  <th className="num" style={{ width: 80 }}>Qty</th>
                  <th className="num" style={{ width: 96 }}>Rate</th>
                  <th className="num" style={{ width: 96 }}>Disc.</th>
                  <th className="num" style={{ width: 110 }}>Amount</th>
                  <th style={{ width: 36 }} />
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => {
                  const amount =
                    Math.round((l.qty * 1000 * Math.round(l.rate * 100)) / 1000) -
                    Math.round(l.discount * 100);
                  const exceeds = l.qty * 1000 > l.stockMilli;
                  return (
                    <tr key={l.key}>
                      <td>
                        <div>{l.name}</div>
                        <div className="muted" style={{ fontSize: 12 }}>
                          {l.unit}
                          {exceeds && <span style={{ color: 'var(--red-600)' }}> · only {formatQty(l.stockMilli)} left</span>}
                        </div>
                      </td>
                      <td className="num">
                        <input
                          className="input sm right"
                          inputMode="decimal"
                          value={l.qty}
                          onChange={(e) => updateLine(l.key, { qty: parseNumber(e.target.value) })}
                        />
                      </td>
                      <td className="num">
                        <input
                          className="input sm right"
                          inputMode="decimal"
                          value={l.rate}
                          onChange={(e) => updateLine(l.key, { rate: parseNumber(e.target.value) })}
                        />
                      </td>
                      <td className="num">
                        <input
                          className="input sm right"
                          inputMode="decimal"
                          value={l.discount}
                          onChange={(e) => updateLine(l.key, { discount: parseNumber(e.target.value) })}
                        />
                      </td>
                      <td className="num mono">{formatPkr(amount)}</td>
                      <td>
                        <button
                          className="btn secondary sm"
                          onClick={() => removeLine(l.key)}
                          aria-label={`Remove ${l.name}`}
                        >
                          ×
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* ---------------- right: credit + payment ---------------- */}
      <div>
        {customer && credit.data && (
          <div style={{ marginBottom: 16 }}>
            <CreditPanel data={credit.data.credit} pendingPaisa={totals.creditAmount} />
          </div>
        )}

        <div className="card">
          <h2>Payment</h2>
          <div className="totals">
            <div className="line">
              <span className="muted">Subtotal</span>
              <span>{formatPkr(totals.subtotal)}</span>
            </div>
            <div className="line">
              <span className="muted">Bill discount</span>
              <input
                className="input sm right"
                style={{ width: 110 }}
                inputMode="decimal"
                value={invoiceDiscount}
                onChange={(e) => setInvoiceDiscount(parseNumber(e.target.value))}
              />
            </div>
            <div className="line big">
              <span>Total</span>
              <span>{formatPkr(totals.total)}</span>
            </div>
          </div>

          <div className="split-pay" style={{ marginTop: 14 }}>
            <div>
              <label className="muted" style={{ fontSize: 12 }}>Cash</label>
              <input
                className="input right"
                inputMode="decimal"
                placeholder="0.00"
                value={paidCash}
                onChange={(e) => setPaidCash(e.target.value)}
              />
            </div>
            <div>
              <label className="muted" style={{ fontSize: 12 }}>Bank</label>
              <input
                className="input right"
                inputMode="decimal"
                placeholder="0.00"
                value={paidBank}
                onChange={(e) => setPaidBank(e.target.value)}
              />
            </div>
          </div>

          <button
            className="btn secondary block sm"
            style={{ marginTop: 8 }}
            onClick={() =>
              setPaidCash(paisaToInput(Math.max(0, totals.total - totals.bank)))
            }
          >
            Cash = full balance
          </button>

          <div className="totals" style={{ marginTop: 12 }}>
            <div className="line credit">
              <span>On credit (udhaar)</span>
              <span>{formatPkr(totals.creditAmount)}</span>
            </div>
          </div>

          <div style={{ marginTop: 12 }}>
            <label className="muted" style={{ fontSize: 12 }}>Note (optional)</label>
            <input
              className="input"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. sprayed wheat field"
            />
          </div>

          {error && <div className="alert error" style={{ marginTop: 12 }}>{error}</div>}

          <button
            className="btn block"
            style={{ marginTop: 12, padding: '14px' }}
            disabled={busy || lines.length === 0 || !customer}
            onClick={() => saveBill()}
          >
            {busy ? 'Saving…' : `Save bill · ${formatPkr(totals.total, { decimals: false })}`}
          </button>
        </div>
      </div>
    </div>
  );
}
