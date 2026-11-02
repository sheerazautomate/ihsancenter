import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type ReceivableRow, type UnpaidInvoice } from '../lib/api';
import { formatPkr, parseNumber } from '../lib/money';

export default function ReceivablesPage() {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<ReceivableRow | null>(null);
  const [amount, setAmount] = useState('');
  const [mode, setMode] = useState<'cash' | 'bank' | 'cheque'>('cash');
  const [account, setAccount] = useState('ca_counter');
  const [reference, setReference] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const receivables = useQuery({
    queryKey: ['receivables'],
    queryFn: () => api<{ customers: ReceivableRow[] }>('/reports/receivables'),
  });

  const unpaid = useQuery({
    queryKey: ['unpaid', selected?.customerId],
    queryFn: () => api<{ invoices: UnpaidInvoice[] }>(`/sales/unpaid/${selected!.customerId}`),
    enabled: !!selected,
  });

  const accounts = useQuery({
    queryKey: ['accounts'],
    queryFn: () => api<{ accounts: { id: string; name: string; type: string }[] }>('/money/accounts'),
  });

  const total = (receivables.data?.customers ?? []).reduce((s, c) => s + c.totalPaisa, 0);

  async function collect() {
    if (!selected) return;
    const value = parseNumber(amount);
    if (value <= 0) return setError('Enter an amount greater than zero');

    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await api<{ receipt: { receiptNo: string; unallocatedPaisa: number } }>('/money/receipts', {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({
          customerId: selected.customerId,
          amount: value,
          mode,
          cashAccountId: account,
          reference: reference || undefined,
        }),
      });

      const extra =
        res.receipt.unallocatedPaisa > 0
          ? ` ${formatPkr(res.receipt.unallocatedPaisa)} is held as an advance.`
          : '';
      setSuccess(`Receipt ${res.receipt.receiptNo} recorded.${extra}`);
      setAmount('');
      setReference('');
      await queryClient.invalidateQueries({ queryKey: ['receivables'] });
      await queryClient.invalidateQueries({ queryKey: ['unpaid'] });
      await queryClient.invalidateQueries({ queryKey: ['customers'] });
      await queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not record the receipt');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="billing" style={{ gridTemplateColumns: selected ? '1.2fr 1fr' : '1fr' }}>
      <div>
        <div className="card">
          <h2>Money owed to the shop</h2>
          <div className="row">
            <div className="grow muted">Oldest money first — the 90+ column is where collection effort should go.</div>
            <div style={{ textAlign: 'right' }}>
              <div className="muted" style={{ fontSize: 12 }}>Total receivable</div>
              <strong className="mono">{formatPkr(total)}</strong>
            </div>
          </div>
        </div>

        <div className="card">
          {receivables.isLoading ? (
            <p className="muted">Loading…</p>
          ) : (receivables.data?.customers ?? []).length === 0 ? (
            <p className="muted">Nobody owes anything. Good sign.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Customer</th>
                  <th className="num">0–30</th>
                  <th className="num">31–60</th>
                  <th className="num">61–90</th>
                  <th className="num">90+</th>
                  <th className="num">Total</th>
                </tr>
              </thead>
              <tbody>
                {receivables.data!.customers.map((c) => (
                  <tr
                    key={c.customerId}
                    onClick={() => setSelected(c)}
                    style={{ cursor: 'pointer', background: selected?.customerId === c.customerId ? 'var(--green-50)' : undefined }}
                  >
                    <td>
                      {c.name}
                      {c.isCreditHold === 1 && <span className="badge void" style={{ marginLeft: 6 }}>hold</span>}
                      <div className="muted" style={{ fontSize: 12 }}>
                        {[c.phone, c.village].filter(Boolean).join(' · ')}
                      </div>
                    </td>
                    <td className="num mono">{c.d0to30 ? formatPkr(c.d0to30, { decimals: false }) : '—'}</td>
                    <td className="num mono" style={{ color: c.d31to60 ? 'var(--amber-600)' : undefined }}>
                      {c.d31to60 ? formatPkr(c.d31to60, { decimals: false }) : '—'}
                    </td>
                    <td className="num mono" style={{ color: c.d61to90 ? 'var(--red-600)' : undefined }}>
                      {c.d61to90 ? formatPkr(c.d61to90, { decimals: false }) : '—'}
                    </td>
                    <td className="num mono" style={{ color: c.d90plus ? 'var(--red-600)' : undefined, fontWeight: c.d90plus ? 600 : 400 }}>
                      {c.d90plus ? formatPkr(c.d90plus, { decimals: false }) : '—'}
                    </td>
                    <td className="num mono">
                      <strong>{formatPkr(c.totalPaisa)}</strong>
                      {c.unappliedPaisa !== 0 && (
                        <div className="muted" style={{ fontSize: 11 }}>
                          {c.unappliedPaisa > 0 ? 'incl. ' : 'advance '}
                          {formatPkr(Math.abs(c.unappliedPaisa), { decimals: false })}
                          {c.unappliedPaisa > 0 ? ' opening' : ''}
                        </div>
                      )}
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
                <div className="muted">
                  Owes <strong>{formatPkr(selected.totalPaisa)}</strong>
                  {selected.creditLimitPaisa > 0 && <> of {formatPkr(selected.creditLimitPaisa, { decimals: false })} limit</>}
                </div>
              </div>
              <button className="btn secondary sm" onClick={() => setSelected(null)}>Close</button>
            </div>
          </div>

          <div className="card">
            <h2>Collect payment</h2>
            <div style={{ display: 'grid', gap: 10 }}>
              <div>
                <label className="muted" style={{ fontSize: 12 }}>Amount received</label>
                <input
                  className="input right"
                  inputMode="decimal"
                  placeholder="0.00"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
              </div>
              <div className="row">
                <button className="btn secondary sm" onClick={() => setAmount(String(selected.totalPaisa / 100))}>
                  Full balance
                </button>
              </div>
              <div className="split-pay">
                <div>
                  <label className="muted" style={{ fontSize: 12 }}>Mode</label>
                  <select className="select" value={mode} onChange={(e) => {
                    const m = e.target.value as 'cash' | 'bank' | 'cheque';
                    setMode(m);
                    setAccount(m === 'cash' ? 'ca_counter' : 'ca_bank');
                  }}>
                    <option value="cash">Cash</option>
                    <option value="bank">Bank</option>
                    <option value="cheque">Cheque</option>
                  </select>
                </div>
                <div>
                  <label className="muted" style={{ fontSize: 12 }}>Account</label>
                  <select className="select" value={account} onChange={(e) => setAccount(e.target.value)}>
                    {accounts.data?.accounts.map((a) => (
                      <option key={a.id} value={a.id}>{a.name}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div>
                <label className="muted" style={{ fontSize: 12 }}>Reference (cheque no. etc.)</label>
                <input className="input" value={reference} onChange={(e) => setReference(e.target.value)} />
              </div>

              {error && <div className="alert error">{error}</div>}
              {success && <div className="alert success">{success}</div>}

              <button className="btn block" disabled={busy} onClick={collect}>
                {busy ? 'Saving…' : 'Record receipt'}
              </button>
              <p className="muted" style={{ fontSize: 12, margin: 0 }}>
                Applied to the oldest invoices first.
              </p>
            </div>
          </div>

          <div className="card">
            <h2>Unpaid invoices</h2>
            {(unpaid.data?.invoices ?? []).length === 0 ? (
              <p className="muted">Nothing outstanding.</p>
            ) : (
              <table>
                <tbody>
                  {unpaid.data!.invoices.map((i) => (
                    <tr key={i.id}>
                      <td>
                        {i.invoice_no}
                        <div className="muted" style={{ fontSize: 12 }}>{i.doc_date}</div>
                      </td>
                      <td className="num mono">{formatPkr(i.bal)}</td>
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
