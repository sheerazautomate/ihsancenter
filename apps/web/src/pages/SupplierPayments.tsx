import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { formatPkr, parseNumber } from '../lib/money';

interface PayableRow {
  companyId: string;
  name: string;
  totalPaisa: number;
}

interface UnpaidPurchase {
  id: string;
  purchase_no: string;
  doc_date: string;
  supplier_invoice_no: string | null;
  total_paisa: number;
  payable_paisa: number;
  lines_paisa: number;
  line_count: number;
}

interface PaymentRow {
  id: string;
  payment_no: string;
  doc_date: string;
  amount_paisa: number;
  mode: string;
  reference: string | null;
}

/**
 * Money the shop owes its companies (suppliers).
 *
 * The mirror of Udhaar. Before this screen existed the only way to record a
 * payment was at the moment a purchase was booked, so a bill taken on credit
 * stayed open forever: the payable never cleared, the payables report drifted
 * from reality, and the company could never satisfy its delete check.
 *
 * Balances come from /reports/payables, which reads the supplier ledger -- not
 * from purchases minus payments, which silently ignored payments made against
 * an opening balance.
 */
export default function SupplierPaymentsPage() {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<PayableRow | null>(null);
  const [amount, setAmount] = useState('');
  const [mode, setMode] = useState<'cash' | 'bank' | 'cheque'>('cash');
  const [account, setAccount] = useState('ca_counter');
  const [reference, setReference] = useState('');
  const [docDate, setDocDate] = useState(() => new Date().toLocaleDateString('en-CA'));
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const payables = useQuery({
    queryKey: ['report-payables'],
    queryFn: () => api<{ companies: PayableRow[] }>('/reports/payables'),
  });

  const unpaid = useQuery({
    queryKey: ['company-unpaid', selected?.companyId],
    queryFn: () => api<{ purchases: UnpaidPurchase[] }>(`/purchases/unpaid/${selected!.companyId}`),
    enabled: !!selected,
  });

  const history = useQuery({
    queryKey: ['company-payments', selected?.companyId],
    queryFn: () => api<{ payments: PaymentRow[] }>(`/purchases/payments/${selected!.companyId}`),
    enabled: !!selected,
  });

  const accounts = useQuery({
    queryKey: ['accounts'],
    queryFn: () => api<{ accounts: { id: string; name: string; type: string }[] }>('/money/accounts'),
  });

  // Only positive balances are a payable. A negative one means the company owes
  // the shop (usually an unrefunded return); paying that would be backwards.
  const owed = (payables.data?.companies ?? []).filter((c) => c.totalPaisa > 0);
  const total = owed.reduce((s, c) => s + c.totalPaisa, 0);

  function pick(c: PayableRow) {
    setSelected(c);
    setAmount(String(c.totalPaisa / 100));
    setError(null);
    setSuccess(null);
    setReference('');
  }

  async function pay() {
    if (!selected) return;
    const value = parseNumber(amount);
    if (value <= 0) return setError('Enter an amount greater than zero');

    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await api<{ paymentNo: string }>('/purchases/payments', {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({
          companyId: selected.companyId,
          amount: value,
          mode,
          cashAccountId: account,
          docDate,
          reference: reference || undefined,
        }),
      });

      setSuccess(`Payment ${res.paymentNo} recorded — ${formatPkr(value * 100)} to ${selected.name}.`);
      setAmount('');
      setReference('');
      await queryClient.invalidateQueries({ queryKey: ['report-payables'] });
      await queryClient.invalidateQueries({ queryKey: ['company-unpaid'] });
      await queryClient.invalidateQueries({ queryKey: ['company-payments'] });
      await queryClient.invalidateQueries({ queryKey: ['company-usage'] });
      await queryClient.invalidateQueries({ queryKey: ['companies-all'] });
      await queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not record the payment');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="billing" style={{ gridTemplateColumns: selected ? '1.2fr 1fr' : '1fr' }}>
      <div>
        <div className="card">
          <h2>Money the shop owes</h2>
          <div className="row">
            <div className="grow muted">
              What you still have to pay each company. Paying here clears the payable and the
              company's balance in the books.
            </div>
            <div style={{ textAlign: 'right' }}>
              <div className="muted" style={{ fontSize: 12 }}>Total payable</div>
              <strong className="mono">{formatPkr(total)}</strong>
            </div>
          </div>
        </div>

        <div className="card">
          {payables.isLoading ? (
            <p className="muted">Loading…</p>
          ) : owed.length === 0 ? (
            <p className="muted">
              Nothing owed to anyone. Credit purchases appear here until they are paid.
            </p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Company</th>
                  <th className="num">Payable</th>
                </tr>
              </thead>
              <tbody>
                {owed.map((c) => (
                  <tr
                    key={c.companyId}
                    onClick={() => pick(c)}
                    style={{
                      cursor: 'pointer',
                      background: selected?.companyId === c.companyId ? 'var(--green-50)' : undefined,
                    }}
                  >
                    <td>{c.name}</td>
                    <td className="num mono">
                      <strong>{formatPkr(c.totalPaisa)}</strong>
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
                  You owe <strong>{formatPkr(selected.totalPaisa)}</strong>
                </div>
              </div>
              <button className="btn secondary sm" onClick={() => setSelected(null)}>Close</button>
            </div>
          </div>

          <div className="card">
            <h2>Record a payment</h2>
            <div style={{ display: 'grid', gap: 10 }}>
              <div>
                <label className="muted" style={{ fontSize: 12 }}>Amount paid</label>
                <input
                  className="input right"
                  inputMode="decimal"
                  placeholder="0.00"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
              </div>
              <div className="row wrap" style={{ gap: 6 }}>
                <button className="btn secondary sm" onClick={() => setAmount(String(selected.totalPaisa / 100))}>
                  Full balance
                </button>
                <button className="btn secondary sm" onClick={() => setAmount(String(selected.totalPaisa / 200))}>
                  Half
                </button>
              </div>
              <div className="split-pay">
                <div>
                  <label className="muted" style={{ fontSize: 12 }}>Mode</label>
                  <select
                    className="select"
                    value={mode}
                    onChange={(e) => {
                      const m = e.target.value as 'cash' | 'bank' | 'cheque';
                      setMode(m);
                      setAccount(m === 'cash' ? 'ca_counter' : 'ca_bank');
                    }}
                  >
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
              <div className="split-pay">
                <div>
                  <label className="muted" style={{ fontSize: 12 }}>Date paid</label>
                  <input
                    className="input"
                    type="date"
                    value={docDate}
                    onChange={(e) => setDocDate(e.target.value)}
                  />
                </div>
                <div>
                  <label className="muted" style={{ fontSize: 12 }}>Reference (cheque no. etc.)</label>
                  <input className="input" value={reference} onChange={(e) => setReference(e.target.value)} />
                </div>
              </div>

              {error && <div className="alert error">{error}</div>}
              {success && <div className="alert success">{success}</div>}

              <button className="btn block" disabled={busy} onClick={pay}>
                {busy ? 'Saving…' : 'Record payment'}
              </button>
              <p className="muted" style={{ fontSize: 12, margin: 0 }}>
                Cannot be more than the payable. Anything else — an advance, a loan — belongs in
                Expenses.
              </p>
            </div>
          </div>

          <div className="card">
            <h2>Unpaid bills</h2>
            {(unpaid.data?.purchases ?? []).length === 0 ? (
              <p className="muted">No credit bills from this company.</p>
            ) : (
              <table>
                <tbody>
                  {unpaid.data!.purchases.map((p) => (
                    <tr key={p.id}>
                      <td>
                        {p.purchase_no}
                        <div className="muted" style={{ fontSize: 12 }}>
                          {p.doc_date}
                          {p.supplier_invoice_no ? ` · bill ${p.supplier_invoice_no}` : ''}
                          {` · ${p.line_count} item${p.line_count === 1 ? '' : 's'}`}
                        </div>
                      </td>
                      <td className="num mono">{formatPkr(p.payable_paisa)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
              Payments reduce the company's balance as a whole; bills are not ticked off one by one.
            </p>
          </div>

          <div className="card">
            <h2>Payments made</h2>
            {(history.data?.payments ?? []).length === 0 ? (
              <p className="muted">Nothing paid yet.</p>
            ) : (
              <table>
                <tbody>
                  {history.data!.payments.map((p) => (
                    <tr key={p.id}>
                      <td>
                        {p.payment_no}
                        <div className="muted" style={{ fontSize: 12 }}>
                          {p.doc_date} · {p.mode}
                          {p.reference ? ` · ${p.reference}` : ''}
                        </div>
                      </td>
                      <td className="num mono">{formatPkr(p.amount_paisa)}</td>
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
