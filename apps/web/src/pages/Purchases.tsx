import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type Company, type Product } from '../lib/api';
import { formatPkr, formatQty, parseNumber } from '../lib/money';

interface PurchaseLine {
  key: string;
  productId: string;
  name: string;
  qty: number;
  rate: number;
}

let counter = 0;

export default function PurchasesPage() {
  const queryClient = useQueryClient();
  const [companyId, setCompanyId] = useState('');
  const [supplierInvoiceNo, setSupplierInvoiceNo] = useState('');
  const [lines, setLines] = useState<PurchaseLine[]>([]);
  const [query, setQuery] = useState('');
  const [freight, setFreight] = useState('');
  const [discount, setDiscount] = useState('');
  const [paidCash, setPaidCash] = useState('');
  const [supplierPayments, setSupplierPayments] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [idemKey, setIdemKey] = useState(() => crypto.randomUUID());

  const companies = useQuery({
    queryKey: ['companies'],
    queryFn: () => api<{ companies: Company[] }>('/catalog/companies'),
  });

  const search = useQuery({
    queryKey: ['products', query],
    queryFn: () => api<{ products: Product[] }>(`/catalog/products?q=${encodeURIComponent(query)}&limit=10`),
    enabled: query.length > 0,
  });

  const recent = useQuery({
    queryKey: ['purchases'],
    queryFn: () =>
      api<{ purchases: { id: string; purchase_no: string; doc_date: string; total_paisa: number; company_name: string }[] }>(
        '/purchases',
      ),
  });

  const totals = useMemo(() => {
    const subtotal = lines.reduce((s, l) => s + Math.round(l.qty * 1000 * Math.round(l.rate * 100) / 1000), 0);
    const total = subtotal - Math.round(parseNumber(discount) * 100) + Math.round(parseNumber(freight) * 100);
    const cash = Math.round(parseNumber(paidCash) * 100);
    return { subtotal, total: Math.max(0, total), cash, payable: Math.max(0, total - cash) };
  }, [lines, discount, freight, paidCash]);

  function addProduct(p: Product) {
    setLines((prev) => {
      const idx = prev.findIndex((l) => l.productId === p.id);
      if (idx >= 0) {
        const copy = [...prev];
        copy[idx] = { ...copy[idx], qty: copy[idx].qty + 1 };
        return copy;
      }
      return [
        ...prev,
        {
          key: `pl-${++counter}`,
          productId: p.id,
          name: p.name,
          qty: 1,
          // default to what we paid last time, not the selling price
          rate: p.purchase_rate_paisa / 100,
        },
      ];
    });
    setQuery('');
  }

  async function save() {
    if (!companyId) return setError('Choose which company this purchase is from');
    if (lines.length === 0) return setError('Add at least one product');

    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await api<{ purchase: { purchaseNo: string } }>('/purchases', {
        method: 'POST',
        headers: { 'Idempotency-Key': idemKey },
        body: JSON.stringify({
          companyId,
          supplierInvoiceNo: supplierInvoiceNo || undefined,
          lines: lines.map((l) => ({ productId: l.productId, qty: l.qty, rate: l.rate })),
          discount: parseNumber(discount) || undefined,
          freight: parseNumber(freight) || undefined,
          paidCash: parseNumber(paidCash) || undefined,
          cashAccountId: parseNumber(paidCash) > 0 ? 'ca_counter' : undefined,
        }),
      });

      setSuccess(`Purchase ${res.purchase.purchaseNo} recorded. Stock updated.`);
      setLines([]);
      setPaidCash('');
      setFreight('');
      setDiscount('');
      setSupplierInvoiceNo('');
      setIdemKey(crypto.randomUUID());
      await queryClient.invalidateQueries({ queryKey: ['purchases'] });
      await queryClient.invalidateQueries({ queryKey: ['stock'] });
      await queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the purchase');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="billing">
      <div>
        <div className="card">
          <h2>New purchase (stock in)</h2>
          <div className="row wrap">
            <div className="grow">
              <label className="muted" style={{ fontSize: 12 }}>Company</label>
              <select className="select" value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
                <option value="">Choose company…</option>
                {companies.data?.companies.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
            <div className="grow">
              <label className="muted" style={{ fontSize: 12 }}>Their invoice no. (optional)</label>
              <input className="input" value={supplierInvoiceNo} onChange={(e) => setSupplierInvoiceNo(e.target.value)} />
            </div>
          </div>

          <div style={{ marginTop: 12 }}>
            <label className="muted" style={{ fontSize: 12 }}>Add product</label>
            <input
              className="input"
              placeholder="Search product…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {search.data && query && (
              <div className="search-results">
                {search.data.products.map((p) => (
                  <div key={p.id} className="search-item" onClick={() => addProduct(p)}>
                    <div>
                      <div className="name">{p.name}</div>
                      <div className="meta">{p.company_name} · {p.pack_size ?? p.unit}</div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div className="mono">last cost {formatPkr(p.purchase_rate_paisa)}</div>
                      <div className="meta">{formatQty(p.qty_on_hand_milli)} in stock</div>
                    </div>
                  </div>
                ))}
                {search.data.products.length === 0 && (
                  <div className="search-item"><div className="meta">No match</div></div>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="card">
          <h2>Items received</h2>
          {lines.length === 0 ? (
            <p className="muted">Nothing added yet.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Product</th>
                  <th className="num" style={{ width: 90 }}>Qty</th>
                  <th className="num" style={{ width: 110 }}>Cost</th>
                  <th className="num" style={{ width: 110 }}>Amount</th>
                  <th style={{ width: 36 }} />
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.key}>
                    <td>{l.name}</td>
                    <td className="num">
                      <input
                        className="input sm right"
                        inputMode="decimal"
                        value={l.qty}
                        onChange={(e) =>
                          setLines((prev) =>
                            prev.map((x) => (x.key === l.key ? { ...x, qty: parseNumber(e.target.value) } : x)),
                          )
                        }
                      />
                    </td>
                    <td className="num">
                      <input
                        className="input sm right"
                        inputMode="decimal"
                        value={l.rate}
                        onChange={(e) =>
                          setLines((prev) =>
                            prev.map((x) => (x.key === l.key ? { ...x, rate: parseNumber(e.target.value) } : x)),
                          )
                        }
                      />
                    </td>
                    <td className="num mono">
                      {formatPkr(Math.round((l.qty * 1000 * Math.round(l.rate * 100)) / 1000))}
                    </td>
                    <td>
                      <button
                        className="btn secondary sm"
                        onClick={() => setLines((prev) => prev.filter((x) => x.key !== l.key))}
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div>
        <div className="card">
          <h2>Total</h2>
          <div className="totals">
            <div className="line">
              <span className="muted">Subtotal</span>
              <span>{formatPkr(totals.subtotal)}</span>
            </div>
            <div className="line">
              <span className="muted">Discount</span>
              <input className="input sm right" style={{ width: 110 }} inputMode="decimal"
                value={discount} onChange={(e) => setDiscount(e.target.value)} />
            </div>
            <div className="line">
              <span className="muted">Freight / carriage</span>
              <input className="input sm right" style={{ width: 110 }} inputMode="decimal"
                value={freight} onChange={(e) => setFreight(e.target.value)} />
            </div>
            <div className="line big">
              <span>Total</span>
              <span>{formatPkr(totals.total)}</span>
            </div>
            <div className="line">
              <span className="muted">Paid now (cash)</span>
              <input className="input sm right" style={{ width: 110 }} inputMode="decimal"
                value={paidCash} onChange={(e) => setPaidCash(e.target.value)} />
            </div>
            <div className="line credit">
              <span>On account (payable)</span>
              <span>{formatPkr(totals.payable)}</span>
            </div>
          </div>

          {error && <div className="alert error" style={{ marginTop: 12 }}>{error}</div>}
          {success && <div className="alert success" style={{ marginTop: 12 }}>{success}</div>}

          <button className="btn block" style={{ marginTop: 12, padding: 14 }} disabled={busy} onClick={save}>
            {busy ? 'Saving…' : 'Record purchase'}
          </button>
          <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
            Freight is added to stock value, not treated as an expense.
          </p>
        </div>

        <div className="card">
          <h2>Recent purchases</h2>
          {(recent.data?.purchases ?? []).length === 0 ? (
            <p className="muted">None yet.</p>
          ) : (
            <table>
              <tbody>
                {recent.data!.purchases.slice(0, 8).map((p) => (
                  <tr key={p.id}>
                    <td>
                      {p.purchase_no}
                      <div className="muted" style={{ fontSize: 12 }}>{p.company_name} · {p.doc_date}</div>
                    </td>
                    <td className="num mono">{formatPkr(p.total_paisa)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {supplierPayments && null}
      </div>
    </div>
  );
}
