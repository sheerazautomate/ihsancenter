import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type ProductCategory, type Company } from '../lib/api';
import { formatPkr, formatQty, parseNumber } from '../lib/money';

interface StockRow {
  id: string;
  name: string;
  unit: string;
  pack_size: string | null;
  qty_on_hand_milli: number;
  reorder_level_milli: number;
  sale_rate_paisa: number;
  purchase_rate_paisa: number;
  category: string;
  company_name: string;
  company_id: string;
}

const CATEGORIES: { value: ProductCategory; label: string }[] = [
  { value: 'insecticide', label: 'Insecticide' },
  { value: 'fungicide', label: 'Fungicide' },
  { value: 'herbicide', label: 'Herbicide' },
  { value: 'fertilizer', label: 'Fertilizer' },
  { value: 'seed', label: 'Seed' },
  { value: 'other', label: 'Other' },
];

export default function StockPage() {
  const queryClient = useQueryClient();
  const [lowOnly, setLowOnly] = useState(false);
  const [company, setCompany] = useState<string>('');

  // ---- new product form ----
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [companyId, setCompanyId] = useState('');
  const [category, setCategory] = useState<ProductCategory>('insecticide');
  const [packSize, setPackSize] = useState('');
  const [unit, setUnit] = useState('pcs');
  const [purchaseRate, setPurchaseRate] = useState('');
  const [saleRate, setSaleRate] = useState('');
  const [reorderLevel, setReorderLevel] = useState('');
  const [openingQty, setOpeningQty] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['stock', lowOnly],
    queryFn: () => api<{ stock: StockRow[] }>(`/catalog/stock?low=${lowOnly ? 1 : 0}`),
  });

  const companies = useQuery({
    queryKey: ['companies'],
    queryFn: () => api<{ companies: Company[] }>('/catalog/companies'),
  });

  const rows = (data?.stock ?? []).filter((r) => !company || r.company_id === company);

  const stockValue = rows.reduce(
    (sum, r) => sum + Math.round((r.qty_on_hand_milli * r.purchase_rate_paisa) / 1000),
    0,
  );
  const retailValue = rows.reduce(
    (sum, r) => sum + Math.round((r.qty_on_hand_milli * r.sale_rate_paisa) / 1000),
    0,
  );

  function resetForm() {
    setName('');
    setPackSize('');
    setUnit('pcs');
    setPurchaseRate('');
    setSaleRate('');
    setReorderLevel('');
    setOpeningQty('');
    setError(null);
  }

  async function save() {
    setError(null);
    setSaved(null);

    if (!name.trim()) return setError('Enter the product name, exactly as it appears on the pack');
    if (!companyId) return setError('Choose which company makes it');

    const cost = parseNumber(purchaseRate);
    const sell = parseNumber(saleRate);
    if (sell <= 0) return setError('Enter a sale rate — without it the product cannot be billed');
    if (cost > 0 && sell < cost) {
      // Not an error: shops do sell at a loss on a clearance line. But a typo here
      // is invisible once the invoice is printed, so make it deliberate.
      const ok = window.confirm(
        `Sale rate ${formatPkr(sell * 100)} is below the purchase rate ${formatPkr(cost * 100)}. ` +
          'Sell at a loss?',
      );
      if (!ok) return;
    }

    setBusy(true);
    try {
      const res = await api<{ id: string }>('/catalog/products', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          companyId,
          category,
          unit: unit.trim() || 'pcs',
          packSize: packSize.trim() || undefined,
          purchaseRate: cost,
          saleRate: sell,
          reorderLevel: parseNumber(reorderLevel),
          openingQty: parseNumber(openingQty),
        }),
      });
      setSaved(res.id);
      resetForm();
      await queryClient.invalidateQueries({ queryKey: ['stock'] });
      await queryClient.invalidateQueries({ queryKey: ['products'] });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the product');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="card">
        <h2>Stock</h2>
        <div className="row wrap">
          <select className="select" style={{ width: 200 }} value={company} onChange={(e) => setCompany(e.target.value)}>
            <option value="">All companies</option>
            {companies.data?.companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <label className="row" style={{ gap: 6 }}>
            <input type="checkbox" checked={lowOnly} onChange={(e) => setLowOnly(e.target.checked)} />
            <span className="muted">Only low stock</span>
          </label>
          <div className="grow" />
          <div style={{ textAlign: 'right' }}>
            <div className="muted" style={{ fontSize: 12 }}>At cost</div>
            <strong className="mono">{formatPkr(stockValue)}</strong>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div className="muted" style={{ fontSize: 12 }}>At retail</div>
            <strong className="mono">{formatPkr(retailValue)}</strong>
          </div>
        </div>
      </div>

      {/* Adding a product is the first thing a new shop needs, so it lives here
          rather than being implied by a purchase. Recording a purchase also adds
          stock to an existing product; this is for the catalogue itself. */}
      <div className="card">
        <div className="row wrap">
          <h2 style={{ margin: 0 }}>Products</h2>
          <div className="grow" />
          <button className="btn" onClick={() => { setShowForm((v) => !v); setError(null); setSaved(null); }}>
            {showForm ? 'Close' : '+ New product'}
          </button>
        </div>

        {saved && !showForm && (
          <div className="alert success" style={{ marginTop: 12 }}>
            Product added. It is now searchable in Purchases and Billing.
          </div>
        )}

        {showForm && (
          <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--slate-200)' }}>
            <div className="form-grid">
              <div className="span-2">
                <label className="muted" style={{ fontSize: 12 }}>Product name</label>
                <input
                  className="input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Delta 4"
                  autoFocus
                />
              </div>

              <div>
                <label className="muted" style={{ fontSize: 12 }}>Company</label>
                <select className="select" value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
                  <option value="">Choose…</option>
                  {companies.data?.companies.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="muted" style={{ fontSize: 12 }}>Type</label>
                <select
                  className="select"
                  value={category}
                  onChange={(e) => setCategory(e.target.value as ProductCategory)}
                >
                  {CATEGORIES.map((c) => (
                    <option key={c.value} value={c.value}>{c.label}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="muted" style={{ fontSize: 12 }}>Pack size</label>
                <input
                  className="input"
                  value={packSize}
                  onChange={(e) => setPackSize(e.target.value)}
                  placeholder="e.g. 250 ml"
                />
              </div>

              <div>
                <label className="muted" style={{ fontSize: 12 }}>Unit</label>
                <input className="input" value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="pcs / bottle / kg" />
              </div>

              <div>
                <label className="muted" style={{ fontSize: 12 }}>Purchase rate (Rs)</label>
                <input
                  className="input"
                  inputMode="decimal"
                  value={purchaseRate}
                  onChange={(e) => setPurchaseRate(e.target.value)}
                  placeholder="0"
                />
              </div>

              <div>
                <label className="muted" style={{ fontSize: 12 }}>Sale rate (Rs)</label>
                <input
                  className="input"
                  inputMode="decimal"
                  value={saleRate}
                  onChange={(e) => setSaleRate(e.target.value)}
                  placeholder="0"
                />
              </div>

              <div>
                <label className="muted" style={{ fontSize: 12 }}>Reorder at</label>
                <input
                  className="input"
                  inputMode="decimal"
                  value={reorderLevel}
                  onChange={(e) => setReorderLevel(e.target.value)}
                  placeholder="optional"
                />
              </div>

              <div>
                <label className="muted" style={{ fontSize: 12 }}>Opening quantity</label>
                <input
                  className="input"
                  inputMode="decimal"
                  value={openingQty}
                  onChange={(e) => setOpeningQty(e.target.value)}
                  placeholder="0"
                />
              </div>
            </div>

            <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>
              Leave opening quantity at 0 if you are going to enter it on the Opening screen, or if
              you will bring it in through Purchases. Entering it here records a stock movement at
              the purchase rate.
            </p>

            {error && <div className="alert error">{error}</div>}

            <div className="row" style={{ marginTop: 10 }}>
              <button className="btn" onClick={save} disabled={busy}>
                {busy ? 'Saving…' : 'Save product'}
              </button>
              <button className="btn secondary" onClick={resetForm} disabled={busy}>Clear</button>
            </div>
          </div>
        )}
      </div>

      <div className="card">
        {isLoading ? (
          <p className="muted">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="muted">
            No products yet. Use <strong>+ New product</strong> above to add the first one.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Product</th>
                <th>Company</th>
                <th className="num">On hand</th>
                <th className="num">Reorder at</th>
                <th className="num">Cost</th>
                <th className="num">Sale</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const low = r.qty_on_hand_milli <= r.reorder_level_milli;
                return (
                  <tr key={r.id}>
                    <td>
                      {r.name}
                      <div className="muted" style={{ fontSize: 12 }}>
                        {r.pack_size ?? r.unit} · {r.category}
                      </div>
                    </td>
                    <td>{r.company_name}</td>
                    <td className="num mono" style={{ color: low ? 'var(--red-600)' : undefined, fontWeight: low ? 600 : 400 }}>
                      {formatQty(r.qty_on_hand_milli)}
                      {r.qty_on_hand_milli <= 0 && <div className="badge void" style={{ marginLeft: 6 }}>out</div>}
                    </td>
                    <td className="num mono muted">{formatQty(r.reorder_level_milli)}</td>
                    <td className="num mono">{formatPkr(r.purchase_rate_paisa)}</td>
                    <td className="num mono">{formatPkr(r.sale_rate_paisa)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
