import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { formatPkr } from '../lib/money';

interface InvoiceRow {
  id: string;
  invoice_no: string;
  doc_date: string;
  total_paisa: number;
  credit_paisa: number;
  status: string;
  customer_name: string;
  outstanding_paisa: number;
  pay_state: 'paid' | 'settled' | 'part' | 'open';
}

export default function InvoicesPage() {
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);

  const { data, isLoading } = useQuery({
    queryKey: ['invoices', from, to],
    queryFn: () => api<{ invoices: InvoiceRow[] }>(`/sales?from=${from}&to=${to}&limit=200`),
    placeholderData: keepPreviousData,
  });

  const invoices = data?.invoices ?? [];
  const totals = invoices.reduce(
    (acc, i) => ({
      total: acc.total + (i.status === 'void' ? 0 : i.total_paisa),
      credit: acc.credit + (i.status === 'void' ? 0 : i.credit_paisa),
    }),
    { total: 0, credit: 0 },
  );

  return (
    <div>
      <div className="card">
        <h2>Invoices</h2>
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
          <div style={{ textAlign: 'right' }}>
            <div className="muted" style={{ fontSize: 12 }}>Sales in range</div>
            <strong className="mono">{formatPkr(totals.total)}</strong>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div className="muted" style={{ fontSize: 12 }}>Of which credit</div>
            <strong className="mono" style={{ color: 'var(--amber-600)' }}>
              {formatPkr(totals.credit)}
            </strong>
          </div>
        </div>
      </div>

      <div className="card">
        {isLoading ? (
          <p className="muted">Loading…</p>
        ) : invoices.length === 0 ? (
          <p className="muted">No invoices in this range.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Invoice</th>
                <th>Date</th>
                <th>Customer</th>
                <th className="num">Total</th>
                <th className="num">Credit</th>
                <th className="num">Still owed</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((i) => (
                <tr key={i.id}>
                  <td>
                    <Link to={`/invoices/${i.id}`}>{i.invoice_no}</Link>
                    {i.status === 'void' && <span className="badge void" style={{ marginLeft: 6 }}>void</span>}
                  </td>
                  <td>{i.doc_date}</td>
                  <td>{i.customer_name}</td>
                  <td className="num mono">{formatPkr(i.total_paisa)}</td>
                  <td className="num mono" style={{ color: i.credit_paisa > 0 ? 'var(--amber-600)' : undefined }}>
                    {i.credit_paisa > 0 ? formatPkr(i.credit_paisa) : '—'}
                  </td>
                  <td className="num mono">
                    {i.status === 'void' ? (
                      <span className="muted">—</span>
                    ) : i.pay_state === 'paid' || i.pay_state === 'settled' ? (
                      <span className="badge">paid</span>
                    ) : i.pay_state === 'part' ? (
                      <>
                        <strong>{formatPkr(i.outstanding_paisa)}</strong>
                        <div className="muted" style={{ fontSize: 11 }}>part paid</div>
                      </>
                    ) : (
                      <strong>{formatPkr(i.outstanding_paisa)}</strong>
                    )}
                  </td>
                  <td>
                    <Link className="btn secondary sm" to={`/invoices/${i.id}`}>
                      Open
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
