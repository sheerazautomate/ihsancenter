import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type CompanyTotals } from '../lib/api';
import { formatPkr } from '../lib/money';

type Tab = 'pnl' | 'companies' | 'products' | 'expenses' | 'payables' | 'integrity';

export default function ReportsPage() {
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(`${today.slice(0, 7)}-01`);
  const [to, setTo] = useState(today);
  const [tab, setTab] = useState<Tab>('companies');

  const qs = `from=${from}&to=${to}`;

  const pnl = useQuery({
    queryKey: ['report-pnl', qs],
    queryFn: () =>
      api<{
        revenuePaisa: number;
        cogsPaisa: number;
        grossProfitPaisa: number;
        expensesPaisa: number;
        netProfitPaisa: number;
      }>(`/reports/profit-loss?${qs}`),
    enabled: tab === 'pnl',
  });

  const companies = useQuery({
    queryKey: ['report-companies', qs],
    queryFn: () => api<{ companies: CompanyTotals[] }>(`/reports/companies?${qs}`),
    enabled: tab === 'companies',
  });

  const products = useQuery({
    queryKey: ['report-products', qs],
    queryFn: () =>
      api<{
        products: { id: string; name: string; companyName: string; qtyMilli: number; revenuePaisa: number; profitPaisa: number }[];
      }>(`/reports/products?${qs}`),
    enabled: tab === 'products',
  });

  const expenses = useQuery({
    queryKey: ['report-expenses', qs],
    queryFn: () =>
      api<{ categories: { id: string; name: string; count: number; totalPaisa: number }[] }>(
        `/reports/expenses?${qs}`,
      ),
    enabled: tab === 'expenses',
  });

  const payables = useQuery({
    queryKey: ['report-payables'],
    queryFn: () => api<{ companies: { companyId: string; name: string; totalPaisa: number }[] }>('/reports/payables'),
    enabled: tab === 'payables',
  });

  const integrity = useQuery({
    queryKey: ['report-integrity'],
    queryFn: () =>
      api<{
        ok: boolean;
        unbalancedDocuments: unknown[];
        stockDrift: unknown[];
        accountsMissingId: unknown[];
        checkedAt: string;
      }>('/reports/integrity'),
    enabled: tab === 'integrity',
  });

  return (
    <div>
      <div className="card">
        <div className="row wrap">
          <div>
            <label className="muted" style={{ fontSize: 12 }}>From</label>
            <input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div>
            <label className="muted" style={{ fontSize: 12 }}>To</label>
            <input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div className="grow" />
          <button className="btn secondary sm" onClick={() => window.print()}>Print</button>
        </div>

        <div className="tabs" style={{ background: 'var(--slate-100)', marginTop: 12, flexWrap: 'wrap' }}>
          {(
            [
              ['companies', 'Company totals'],
              ['pnl', 'Profit & loss'],
              ['products', 'Product profit'],
              ['expenses', 'Expenses'],
              ['payables', 'Company payables'],
              ['integrity', 'Books check'],
            ] as [Tab, string][]
          ).map(([key, label]) => (
            <button
              key={key}
              className="tab"
              style={{
                color: tab === key ? 'var(--green-900)' : 'var(--slate-500)',
                background: tab === key ? 'white' : 'transparent',
                fontWeight: tab === key ? 600 : 400,
              }}
              onClick={() => setTab(key)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {tab === 'companies' && (
        <div className="card">
          <h2>Company totals · {from} to {to}</h2>
          <table>
            <thead>
              <tr>
                <th>Company</th>
                <th className="num">Purchases</th>
                <th className="num">Sales</th>
                <th className="num">Cost of sales</th>
                <th className="num">Gross profit</th>
                <th className="num">Payable</th>
              </tr>
            </thead>
            <tbody>
              {(companies.data?.companies ?? []).map((c) => (
                <tr key={c.companyId}>
                  <td><strong>{c.name}</strong></td>
                  <td className="num mono">{formatPkr(c.purchasesPaisa, { decimals: false })}</td>
                  <td className="num mono">{formatPkr(c.salesPaisa, { decimals: false })}</td>
                  <td className="num mono">{formatPkr(c.costPaisa, { decimals: false })}</td>
                  <td className="num mono">{formatPkr(c.grossProfitPaisa, { decimals: false })}</td>
                  <td className="num mono">{formatPkr(c.payablePaisa, { decimals: false })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'pnl' && pnl.data && (
        <div className="card">
          <h2>Profit &amp; loss · {from} to {to}</h2>
          <table>
            <tbody>
              <tr><td>Revenue (net of returns)</td><td className="num mono">{formatPkr(pnl.data.revenuePaisa)}</td></tr>
              <tr><td>Less: cost of goods sold</td><td className="num mono">-{formatPkr(pnl.data.cogsPaisa)}</td></tr>
              <tr><td><strong>Gross profit</strong></td><td className="num mono"><strong>{formatPkr(pnl.data.grossProfitPaisa)}</strong></td></tr>
              <tr><td>Less: expenses</td><td className="num mono">-{formatPkr(pnl.data.expensesPaisa)}</td></tr>
              <tr>
                <td><strong>Net profit</strong></td>
                <td className="num mono" style={{ color: pnl.data.netProfitPaisa >= 0 ? 'var(--green-700)' : 'var(--red-600)' }}>
                  <strong>{formatPkr(pnl.data.netProfitPaisa)}</strong>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {tab === 'products' && (
        <div className="card">
          <h2>Product profit · {from} to {to}</h2>
          {(products.data?.products ?? []).length === 0 ? (
            <p className="muted">No sales in this period.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Company</th>
                  <th className="num">Revenue</th>
                  <th className="num">Profit</th>
                  <th className="num">Margin</th>
                </tr>
              </thead>
              <tbody>
                {products.data!.products.map((p) => (
                  <tr key={p.id}>
                    <td>{p.name}</td>
                    <td className="muted">{p.companyName}</td>
                    <td className="num mono">{formatPkr(p.revenuePaisa, { decimals: false })}</td>
                    <td className="num mono">{formatPkr(p.profitPaisa, { decimals: false })}</td>
                    <td className="num mono">
                      {p.revenuePaisa > 0 ? `${((p.profitPaisa / p.revenuePaisa) * 100).toFixed(0)}%` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {tab === 'expenses' && (
        <div className="card">
          <h2>Expenses by category · {from} to {to}</h2>
          <table>
            <thead>
              <tr><th>Category</th><th className="num">Entries</th><th className="num">Total</th></tr>
            </thead>
            <tbody>
              {(expenses.data?.categories ?? []).map((c) => (
                <tr key={c.id}>
                  <td>{c.name}</td>
                  <td className="num mono">{c.count}</td>
                  <td className="num mono">{formatPkr(c.totalPaisa)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'payables' && (
        <div className="card">
          <h2>What the shop owes the companies</h2>
          {(payables.data?.companies ?? []).length === 0 ? (
            <p className="muted">Nothing owed to any company.</p>
          ) : (
            <table>
              <thead>
                <tr><th>Company</th><th className="num">Payable</th></tr>
              </thead>
              <tbody>
                {payables.data!.companies.map((c) => (
                  <tr key={c.companyId}>
                    <td>{c.name}</td>
                    <td className="num mono">{formatPkr(c.totalPaisa)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {tab === 'integrity' && integrity.data && (
        <div className="card">
          <h2>Books check</h2>
          <p className="muted">
            Every document's ledger entries must sum to zero, and cached stock must equal
            the sum of its movements. Last checked {new Date(integrity.data.checkedAt).toLocaleString()}.
          </p>
          {integrity.data.ok ? (
            <div className="alert success">All documents balance and stock reconciles.</div>
          ) : (
            <>
              <div className="alert error">Something does not reconcile. Details below.</div>
              <pre style={{ fontSize: 12, overflow: 'auto', background: 'var(--slate-50)', padding: 12 }}>
                {JSON.stringify(integrity.data, null, 2)}
              </pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}
