import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, type Dashboard } from '../lib/api';
import { formatPkr } from '../lib/money';

export default function DashboardPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => api<Dashboard>('/reports/dashboard'),
    refetchInterval: 60_000,
  });

  if (isLoading || !data) return <p className="muted">Loading…</p>;

  const today = data.today ?? {
    salesPaisa: 0,
    collectedPaisa: 0,
    creditGivenPaisa: 0,
    expensesPaisa: 0,
    receiptsPaisa: 0,
    invoiceCount: 0,
  };

  return (
    <div>
      {/* today */}
      <div className="card">
        <h2>Today · {data.date}</h2>
        <div className="row wrap" style={{ gap: 28 }}>
          <Stat label="Sales" value={formatPkr(today.salesPaisa)} />
          <Stat label="Cash collected" value={formatPkr(today.collectedPaisa)} />
          <Stat label="Given on credit" value={formatPkr(today.creditGivenPaisa)} tone="credit" />
          <Stat label="Receipts" value={formatPkr(today.receiptsPaisa)} />
          <Stat label="Expenses" value={formatPkr(today.expensesPaisa)} tone="bad" />
          <Stat label="Invoices" value={String(today.invoiceCount)} />
        </div>
      </div>

      {/* month profit */}
      <div className="card">
        <h2>This month · from {data.monthFrom}</h2>
        <div className="row wrap" style={{ gap: 28 }}>
          <Stat label="Revenue" value={formatPkr(data.profit.revenuePaisa)} />
          <Stat label="Cost of goods" value={formatPkr(data.profit.cogsPaisa)} />
          <Stat label="Gross profit" value={formatPkr(data.profit.grossProfitPaisa)} />
          <Stat label="Expenses" value={formatPkr(data.profit.expensesPaisa)} tone="bad" />
          <Stat
            label="Net profit"
            value={formatPkr(data.profit.netProfitPaisa)}
            tone={data.profit.netProfitPaisa >= 0 ? 'good' : 'bad'}
          />
        </div>
      </div>

      <div className="billing" style={{ gridTemplateColumns: '1fr 1fr' }}>
        {/* balances */}
        <div className="card">
          <h2>Balances</h2>
          <table>
            <tbody>
              {data.cash.map((a) => (
                <tr key={a.id}>
                  <td>
                    {a.name}
                    <div className="muted" style={{ fontSize: 12 }}>{a.type}</div>
                  </td>
                  <td className="num mono">{formatPkr(a.balancePaisa)}</td>
                </tr>
              ))}
              <tr>
                <td>
                  <strong>Receivable (udhaar)</strong>
                  <div className="muted" style={{ fontSize: 12 }}>what customers owe you</div>
                </td>
                <td className="num mono">
                  <strong>{formatPkr(data.totalReceivablePaisa)}</strong>
                </td>
              </tr>
              <tr>
                <td>
                  Low stock items
                  <div className="muted" style={{ fontSize: 12 }}>at or below reorder level</div>
                </td>
                <td className="num mono">
                  <Link to="/stock">{data.lowStockCount}</Link>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        {/* company totals — the report the shop asked for */}
        <div className="card">
          <h2>Companies this month</h2>
          <table>
            <thead>
              <tr>
                <th>Company</th>
                <th className="num">Sales</th>
                <th className="num">Profit</th>
                <th className="num">Payable</th>
              </tr>
            </thead>
            <tbody>
              {data.companies.map((c) => (
                <tr key={c.companyId}>
                  <td>{c.name}</td>
                  <td className="num mono">{formatPkr(c.salesPaisa, { decimals: false })}</td>
                  <td className="num mono" style={{ color: c.grossProfitPaisa >= 0 ? undefined : 'var(--red-600)' }}>
                    {formatPkr(c.grossProfitPaisa, { decimals: false })}
                  </td>
                  <td className="num mono">{formatPkr(c.payablePaisa, { decimals: false })}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ marginTop: 10 }}>
            <Link className="btn secondary sm" to="/reports">
              All reports
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'bad' | 'credit' }) {
  const color =
    tone === 'good' ? 'var(--green-700)' : tone === 'bad' ? 'var(--red-600)' : tone === 'credit' ? 'var(--amber-600)' : undefined;
  return (
    <div>
      <div className="muted" style={{ fontSize: 12 }}>{label}</div>
      <div className="mono" style={{ fontSize: 20, fontWeight: 600, color }}>{value}</div>
    </div>
  );
}
