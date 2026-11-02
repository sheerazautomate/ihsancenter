import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Customer } from '../lib/api';
import { formatPkr, paisaToInput, parseNumber } from '../lib/money';
import { downloadReport } from '../lib/export';

interface LedgerEntry {
  entry_date: string;
  doc_type: string;
  debit_paisa: number;
  credit_paisa: number;
  memo: string | null;
  running_paisa: number;
}

/** Blank form state, so "new" and "edit" share one shape. */
interface FormState {
  id: string | null;
  name: string;
  phone: string;
  village: string;
  type: string;
  creditLimit: string;
  isCreditHold: boolean;
}

interface CustomerUsage {
  invoices: number;
  returns: number;
  receipts: number;
  ledgerEntries: number;
  balancePaisa: number;
  canDelete: boolean;
  canDeactivate: boolean;
  blockedBy: string | null;
}

const EMPTY: FormState = {
  id: null,
  name: '',
  phone: '',
  village: '',
  type: 'farmer',
  creditLimit: '',
  isCreditHold: false,
};

/**
 * Must match the customers.type CHECK constraint in the schema -- the database
 * rejects anything else, so adding an option here without a migration would fail
 * at save time rather than at review time.
 */
const TYPES = [
  { value: 'farmer', label: 'Farmer' },
  { value: 'dealer', label: 'Dealer' },
];

export default function CustomersPage() {
  const queryClient = useQueryClient();
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<Customer | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState<string | null>(null);

  const { data } = useQuery({
    queryKey: ['customers', 'list', q],
    // all=1: a deactivated customer has to stay findable, otherwise hiding someone
    // by mistake is unrecoverable from this screen.
    queryFn: () => api<{ customers: Customer[] }>(`/customers?q=${encodeURIComponent(q)}&limit=50&all=1`),
  });

  const ledger = useQuery({
    queryKey: ['customer-ledger', selected?.id],
    queryFn: () => api<{ entries: LedgerEntry[] }>(`/customers/${selected!.id}/ledger`),
    enabled: !!selected,
  });

  // Checked before the manager clicks, not after: a customer with history must
  // show why they cannot go, rather than a button that fails on press.
  const usage = useQuery({
    queryKey: ['customer-usage', selected?.id],
    queryFn: () =>
      api<{ usage: CustomerUsage }>(`/customers/${selected!.id}/usage`),
    enabled: !!selected,
  });

  // Keep the detail pane in step with a save, so the header shows the new name
  // without needing the user to reselect the row.
  useEffect(() => {
    if (!selected) return;
    const fresh = data?.customers.find((c) => c.id === selected.id);
    if (fresh && (fresh.name !== selected.name || fresh.phone !== selected.phone)) setSelected(fresh);
  }, [data, selected]);

  function startEdit(c: Customer) {
    setError(null);
    setNotice(null);
    setForm({
      id: c.id,
      name: c.name,
      phone: c.phone ?? '',
      village: c.village ?? '',
      type: c.type ?? 'farmer',
      creditLimit: c.credit_limit_paisa ? paisaToInput(c.credit_limit_paisa) : '',
      isCreditHold: c.is_credit_hold === 1,
    });
  }

  async function save() {
    if (!form) return;
    setError(null);
    setNotice(null);

    if (!form.name.trim()) return setError('Enter the customer name');

    setBusy(true);
    try {
      if (form.id) {
        await api(`/customers/${form.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            name: form.name.trim(),
            phone: form.phone.trim() || null,
            village: form.village.trim() || null,
            creditLimit: parseNumber(form.creditLimit),
            isCreditHold: form.isCreditHold,
          }),
        });
        setNotice(`${form.name.trim()} updated`);
      } else {
        await api('/customers', {
          method: 'POST',
          body: JSON.stringify({
            name: form.name.trim(),
            phone: form.phone.trim() || undefined,
            village: form.village.trim() || undefined,
            type: form.type,
            creditLimit: parseNumber(form.creditLimit),
          }),
        });
        setNotice(`${form.name.trim()} added`);
      }
      setForm(null);
      await queryClient.invalidateQueries({ queryKey: ['customers'] });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the customer');
    } finally {
      setBusy(false);
    }
  }

  async function exportCsv(slug: string, label: string) {
    if (!selected) return;
    setError(null);
    setExporting(slug);
    try {
      await downloadReport(slug, { customerId: selected.id });
      setNotice(`${label} downloaded.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Download failed');
    } finally {
      setExporting(null);
    }
  }

  async function remove(c: Customer) {
    setError(null);
    setNotice(null);
    // Typed confirmation, not a yes/no box: a duplicate is deleted in a second,
    // and an accidental "OK" here costs a customer's whole history.
    const typed = window.prompt(`Type the name to delete ${c.name} permanently:`);
    if (typed === null) return;
    if (typed.trim().toLowerCase() !== c.name.trim().toLowerCase()) {
      return setError('The name did not match, so nothing was deleted.');
    }

    setBusy(true);
    try {
      await api(`/customers/${c.id}`, { method: 'DELETE' });
      setNotice(`${c.name} deleted`);
      setSelected(null);
      await queryClient.invalidateQueries({ queryKey: ['customers'] });
      await queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    } catch (e) {
      // The server names the blocker; show it verbatim.
      setError(e instanceof Error ? e.message : 'Could not delete the customer');
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(c: Customer) {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      await api(`/customers/${c.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive: c.is_active !== 1 }),
      });
      setNotice(c.is_active === 1 ? `${c.name} deactivated` : `${c.name} reactivated`);
      await queryClient.invalidateQueries({ queryKey: ['customers'] });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not update the customer');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="billing" style={{ gridTemplateColumns: selected ? '1fr 1.2fr' : '1fr' }}>
      <div>
        <div className="card">
          <div className="row wrap">
            <h2 style={{ margin: 0 }}>Customers</h2>
            <div className="grow" />
            <button
              className="btn"
              onClick={() => {
                setError(null);
                setNotice(null);
                setForm({ ...EMPTY });
              }}
            >
              + New customer
            </button>
          </div>
          <input
            className="input"
            style={{ marginTop: 12 }}
            placeholder="Search by name, phone or village…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          {notice && <div className="alert success" style={{ marginTop: 12 }}>{notice}</div>}
        </div>

        {form && (
          <div className="card">
            <h2>{form.id ? 'Edit customer' : 'New customer'}</h2>
            <div className="form-grid">
              <div className="span-2">
                <label className="muted" style={{ fontSize: 12 }}>Name</label>
                <input
                  className="input"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="e.g. Ali Muhammad"
                  autoFocus
                />
              </div>
              <div>
                <label className="muted" style={{ fontSize: 12 }}>Phone</label>
                <input
                  className="input"
                  value={form.phone}
                  onChange={(e) => setForm({ ...form, phone: e.target.value })}
                  placeholder="03xx…"
                  inputMode="tel"
                />
              </div>
              <div>
                <label className="muted" style={{ fontSize: 12 }}>Village / area</label>
                <input
                  className="input"
                  value={form.village}
                  onChange={(e) => setForm({ ...form, village: e.target.value })}
                />
              </div>
              {!form.id && (
                <div>
                  <label className="muted" style={{ fontSize: 12 }}>Type</label>
                  <select
                    className="select"
                    value={form.type}
                    onChange={(e) => setForm({ ...form, type: e.target.value })}
                  >
                    {TYPES.map((t) => (
                      <option key={t.value} value={t.value}>{t.label}</option>
                    ))}
                  </select>
                </div>
              )}
              <div>
                <label className="muted" style={{ fontSize: 12 }}>Credit limit (Rs)</label>
                <input
                  className="input"
                  inputMode="decimal"
                  value={form.creditLimit}
                  onChange={(e) => setForm({ ...form, creditLimit: e.target.value })}
                  placeholder="blank = no limit"
                />
              </div>
              {form.id && (
                <div className="span-2">
                  <label className="row" style={{ gap: 8 }}>
                    <input
                      type="checkbox"
                      checked={form.isCreditHold}
                      onChange={(e) => setForm({ ...form, isCreditHold: e.target.checked })}
                    />
                    <span>
                      Stop new credit (udhaar)
                      <span className="muted" style={{ display: 'block', fontSize: 12 }}>
                        Cash sales still go through. Use this when a customer is not paying.
                      </span>
                    </span>
                  </label>
                </div>
              )}
            </div>

            {error && <div className="alert error" style={{ marginTop: 12 }}>{error}</div>}

            <div className="row" style={{ marginTop: 12 }}>
              <button className="btn" onClick={save} disabled={busy}>
                {busy ? 'Saving…' : form.id ? 'Save changes' : 'Add customer'}
              </button>
              <button className="btn secondary" onClick={() => setForm(null)} disabled={busy}>
                Cancel
              </button>
            </div>
          </div>
        )}

        <div className="card">
          {(data?.customers ?? []).length === 0 ? (
            <p className="muted">
              {q ? 'No customers match that search.' : 'No customers yet. Use + New customer above.'}
            </p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Customer</th>
                  <th className="num">Outstanding</th>
                  <th className="num">Limit</th>
                  <th />
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
                      {c.is_active === 0 && <span className="badge void" style={{ marginLeft: 6 }}>inactive</span>}
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
                    <td className="num">
                      <button
                        className="btn secondary sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelected(c);
                          startEdit(c);
                        }}
                        aria-label={`Edit ${c.name}`}
                      >
                        Edit
                      </button>
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
                <h2 style={{ marginBottom: 2 }}>
                  {selected.name}
                  {selected.is_active === 0 && <span className="badge void" style={{ marginLeft: 8 }}>inactive</span>}
                </h2>
                <div className="muted">
                  {[selected.phone, selected.village].filter(Boolean).join(' · ') || 'No phone or village recorded'}
                </div>
              </div>
              <button className="btn secondary sm" onClick={() => startEdit(selected)}>
                Edit
              </button>
              <button
                className="btn secondary sm"
                disabled={exporting !== null}
                onClick={() => exportCsv('customer-history', 'Full history')}
                title="Download this customer's whole history as Excel"
              >
                {exporting === 'customer-history' ? '…' : 'History'}
              </button>
              <button className="btn secondary sm" onClick={() => setSelected(null)}>
                Close
              </button>
            </div>
            <table style={{ marginTop: 12 }}>
              <tbody>
                <tr>
                  <td className="muted">Outstanding</td>
                  <td className="num mono">{formatPkr(selected.outstanding_paisa)}</td>
                </tr>
                <tr>
                  <td className="muted">Credit limit</td>
                  <td className="num mono">
                    {selected.credit_limit_paisa > 0 ? formatPkr(selected.credit_limit_paisa) : 'No limit'}
                  </td>
                </tr>
                <tr>
                  <td className="muted">Credit</td>
                  <td className="num">
                    {selected.is_credit_hold === 1 ? (
                      <span className="badge void">on hold</span>
                    ) : (
                      <span className="muted">allowed</span>
                    )}
                  </td>
                </tr>
              </tbody>
            </table>

            {usage.data && !usage.data.usage.canDelete && (
              <div className="alert warn" style={{ marginTop: 12 }}>
                <strong>This customer cannot be deleted.</strong>{' '}
                {(usage.data.usage.blockedBy ?? '').replace(/\.$/, '')}.
                <div style={{ marginTop: 4 }}>
                  {usage.data.usage.canDeactivate
                    ? 'Deactivate them instead — they disappear from billing and the history stays.'
                    : 'This row is used by the billing screen and must stay.'}
                </div>
              </div>
            )}

            {error && <div className="alert error" style={{ marginTop: 12 }}>{error}</div>}
            {notice && <div className="alert success" style={{ marginTop: 12 }}>{notice}</div>}

            <div className="row wrap" style={{ marginTop: 12 }}>
              {usage.data?.usage.canDeactivate && (
                <button className="btn secondary" onClick={() => toggleActive(selected)} disabled={busy}>
                  {selected.is_active === 0 ? 'Reactivate' : 'Deactivate'}
                </button>
              )}
              <button
                className="btn danger"
                onClick={() => remove(selected)}
                disabled={busy || !usage.data?.usage.canDelete}
                title={
                  usage.data?.usage.canDelete
                    ? 'Delete this customer permanently'
                    : usage.data?.usage.blockedBy ?? 'Checking…'
                }
              >
                Delete customer
              </button>
            </div>
            <p className="muted" style={{ fontSize: 12, marginBottom: 0, marginTop: 6 }}>
              Deleting is only for a customer added by mistake or entered twice. Anyone with
              invoices, receipts or an outstanding balance keeps their history.
            </p>
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
