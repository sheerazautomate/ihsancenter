import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type Customer } from '../lib/api';
import { formatPkr } from '../lib/money';

interface LedgerEntry {
  entry_date: string;
  doc_type: string;
  debit_paisa: number;
  credit_paisa: number;
  memo: string | null;
  running_paisa: number;
}

export default function CustomersPage() {
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<Customer | null>(null);

  const { data } = useQuery({
    queryKey: ['customers', 'list', q],
    queryFn: () => api<{ customers: Customer[] }>(`/customers?q=${encodeURIComponent(q)}&limit=50`),
  });

  const ledger = useQuery({
    queryKey: ['customer-ledger', selected?.id],
    queryFn: () => api<{ entries: LedgerEntry[] }>(`/customers/${selected!.id}/ledger`),
    enabled: !!selected,
  });

  return (
    <div className="billing" style={{ gridTemplateColumns: selected ? '1fr 1.2fr' : '1fr' }}>
      <div>
        <div className="card">
          <h2>Customers</h2>
          <input
            className="input"
            placeholder="Search by name, phone or village…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>

        <div className="card">
          {(data?.customers ?? []).length === 0 ? (
            <p className="muted">No customers found.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Customer</th>
                  <th className="num">Outstanding</th>
                  <th className="num">Limit</th>
                </tr>
              </thead>
              <tbody>
                {data!.customers.map((c) => (
                  <tr
                    key={c.id}
                    onClick={() => setSelected(c)}
                    style={{ cursor: 'pointer', background: selected?.id === c.id ? 'var(--green-50)' : undefined }}
                  >
                    <td>
                      {c.name}
                      {c.is_credit_hold === 1 && <span className="badge void" style={{ marginLeft: 6 }}>hold</span>}
                      <div className="muted" style={{ fontSize: 12 }}>
                        {[c.phone, c.village].filter(Boolean).join(' · ') || c.type}
                      </div>
                    </td>
                    <td className="num mono" style={{ color: c.outstanding_paisa > 0 ? 'var(--amber-600)' : undefined }}>
                      {c.outstanding_paisa > 0 ? formatPkr(c.outstanding_paisa) : '—'}
                    </td>
                    <td className="num mono muted">
                      {c.credit_limit_paisa > 0 ? formatPkr(c.credit_limit_paisa, { decimals: false }) : 'None'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {selected && (
        <div>
          <div className="card">
            <div className="row">
              <div className="grow">
                <h2 style={{ marginBottom: 2 }}>{selected.name}</h2>
                <div className="muted">{[selected.phone, selected.village].filter(Boolean).join(' · ')}</div>
              </div>
              <button className="btn secondary sm" onClick={() => setSelected(null)}>
                Close
              </button>
            </div>
          </div>

          <div className="card">
            <h2>Ledger</h2>
            {ledger.isLoading ? (
              <p className="muted">Loading…</p>
            ) : (ledger.data?.entries ?? []).length === 0 ? (
              <p className="muted">No transactions yet.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Detail</th>
                    <th className="num">Debit</th>
                    <th className="num">Credit</th>
                    <th className="num">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {ledger.data!.entries.map((e, i) => (
                    <tr key={i}>
                      <td className="muted">{e.entry_date}</td>
                      <td>
                        {e.memo ?? e.doc_type}
                        <div className="muted" style={{ fontSize: 11 }}>{e.doc_type}</div>
                      </td>
                      <td className="num mono">{e.debit_paisa ? formatPkr(e.debit_paisa) : ''}</td>
                      <td className="num mono">{e.credit_paisa ? formatPkr(e.credit_paisa) : ''}</td>
                      <td className="num mono">{formatPkr(e.running_paisa)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
