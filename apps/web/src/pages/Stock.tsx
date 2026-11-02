import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { formatPkr, formatQty } from '../lib/money';

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

export default function StockPage() {
  const [lowOnly, setLowOnly] = useState(false);
  const [company, setCompany] = useState<string>('');

  const { data, isLoading } = useQuery({
    queryKey: ['stock', lowOnly],
    queryFn: () => api<{ stock: StockRow[] }>(`/catalog/stock?low=${lowOnly ? 1 : 0}`),
  });

  const companies = useQuery({
    queryKey: ['companies'],
    queryFn: () => api<{ companies: { id: string; name: string }[] }>('/catalog/companies'),
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

      <div className="card">
        {isLoading ? (
          <p className="muted">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="muted">No products yet. Products are created when you record a purchase.</p>
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
