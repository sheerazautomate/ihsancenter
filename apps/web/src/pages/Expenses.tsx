import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type ExpenseCategory } from '../lib/api';
import { formatPkr, parseNumber } from '../lib/money';

export default function ExpensesPage() {
  const queryClient = useQueryClient();
  const today = new Date().toISOString().slice(0, 10);

  const [categoryId, setCategoryId] = useState('');
  const [amount, setAmount] = useState('');
  const [account, setAccount] = useState('ca_counter');
  const [payee, setPayee] = useState('');
  const [notes, setNotes] = useState('');
  const [docDate, setDocDate] = useState(today);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const categories = useQuery({
    queryKey: ['categories'],
    queryFn: () => api<{ categories: ExpenseCategory[] }>('/money/categories'),
  });

  const accounts = useQuery({
    queryKey: ['accounts'],
    queryFn: () => api<{ accounts: { id: string; name: string; type: string }[] }>('/money/accounts'),
  });

  const list = useQuery({
    queryKey: ['expenses', docDate],
    queryFn: () =>
      api<{ expenses: { id: string; doc_date: string; amount_paisa: number; payee: string | null; category_name: string }[] }>(
        `/money/expenses?from=${docDate.slice(0, 7)}-01&to=${docDate}`,
      ),
  });

  const monthTotal = (list.data?.expenses ?? []).reduce((s, e) => s + e.amount_paisa, 0);

  async function save() {
    const value = parseNumber(amount);
    if (!categoryId) return setError('Choose a category');
    if (value <= 0) return setError('Enter an amount');

    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      await api('/money/expenses', {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({
          categoryId,
          docDate,
          amount: value,
          cashAccountId: account,
          payee: payee || undefined,
          notes: notes || undefined,
        }),
      });
      setSuccess(`Expense of ${formatPkr(value * 100)} recorded.`);
      setAmount('');
      setPayee('');
      setNotes('');
      await queryClient.invalidateQueries({ queryKey: ['expenses'] });
      await queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the expense');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="billing" style={{ gridTemplateColumns: '1fr 1.2fr' }}>
      <div className="card">
        <h2>Record an expense</h2>
        <div style={{ display: 'grid', gap: 10 }}>
          <div>
            <label className="muted" style={{ fontSize: 12 }}>Category</label>
            <select className="select" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              <option value="">Choose…</option>
              {categories.data?.categories.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="muted" style={{ fontSize: 12 }}>Amount</label>
            <input className="input right" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
          </div>
          <div className="split-pay">
            <div>
              <label className="muted" style={{ fontSize: 12 }}>Paid from</label>
              <select className="select" value={account} onChange={(e) => setAccount(e.target.value)}>
                {accounts.data?.accounts.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="muted" style={{ fontSize: 12 }}>Date</label>
              <input className="input" type="date" value={docDate} onChange={(e) => setDocDate(e.target.value)} />
            </div>
          </div>
          <div>
            <label className="muted" style={{ fontSize: 12 }}>Paid to</label>
            <input className="input" value={payee} onChange={(e) => setPayee(e.target.value)} placeholder="e.g. LESCO, landlord" />
          </div>
          <div>
            <label className="muted" style={{ fontSize: 12 }}>Note</label>
            <input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>

          {error && <div className="alert error">{error}</div>}
          {success && <div className="alert success">{success}</div>}

          <button className="btn block" disabled={busy} onClick={save}>
            {busy ? 'Saving…' : 'Save expense'}
          </button>
        </div>
      </div>

      <div className="card">
        <div className="row">
          <h2 className="grow">This month</h2>
          <strong className="mono">{formatPkr(monthTotal)}</strong>
        </div>
        {(list.data?.expenses ?? []).length === 0 ? (
          <p className="muted">No expenses recorded this month.</p>
        ) : (
          <table>
            <tbody>
              {list.data!.expenses.map((e) => (
                <tr key={e.id}>
                  <td>
                    {e.category_name}
                    <div className="muted" style={{ fontSize: 12 }}>
                      {e.doc_date}{e.payee ? ` · ${e.payee}` : ''}
                    </div>
                  </td>
                  <td className="num mono">{formatPkr(e.amount_paisa)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
