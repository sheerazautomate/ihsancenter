import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { downloadReport } from '../lib/export';

interface CompanyRow {
  id: string;
  name: string;
  contact_person: string | null;
  phone: string | null;
  address: string | null;
  notes: string | null;
  is_active: number;
}

interface CompanyUsage {
  products: number;
  purchases: number;
  purchaseReturns: number;
  payments: number;
  ledgerEntries: number;
  balancePaisa: number;
  canDelete: boolean;
  blockedBy: string | null;
}

interface FormState {
  id: string | null;
  name: string;
  contactPerson: string;
  phone: string;
  address: string;
  notes: string;
  isActive: boolean;
}

const EMPTY: FormState = {
  id: null,
  name: '',
  contactPerson: '',
  phone: '',
  address: '',
  notes: '',
  isActive: true,
};

/**
 * Companies — the four (or more) suppliers the shop buys from.
 *
 * Create, edit, deactivate and — only when genuinely unused — delete. Deletion is
 * gated on a dependency audit, not merely a zero balance: a company can be fully
 * paid and still own a product catalogue and a purchase history. The screen loads
 * that audit up front so the manager is told why, instead of being refused after
 * clicking.
 */
export default function CompaniesPage() {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<FormState | null>(null);
  const [selected, setSelected] = useState<CompanyRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState<string | null>(null);

  const companies = useQuery({
    queryKey: ['companies-all'],
    queryFn: () => api<{ companies: CompanyRow[] }>('/catalog/companies?all=1'),
  });

  const usage = useQuery({
    queryKey: ['company-usage', selected?.id],
    queryFn: () => api<{ company: CompanyRow; usage: CompanyUsage }>(`/catalog/companies/${selected!.id}`),
    enabled: !!selected,
  });

  function startNew() {
    setError(null);
    setNotice(null);
    setForm({ ...EMPTY });
  }

  function startEdit(c: CompanyRow) {
    setError(null);
    setNotice(null);
    setForm({
      id: c.id,
      name: c.name,
      contactPerson: c.contact_person ?? '',
      phone: c.phone ?? '',
      address: c.address ?? '',
      notes: c.notes ?? '',
      isActive: c.is_active === 1,
    });
  }

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ['companies-all'] });
    await queryClient.invalidateQueries({ queryKey: ['companies'] });
    await queryClient.invalidateQueries({ queryKey: ['company-usage'] });
  }

  async function save() {
    if (!form) return;
    setError(null);
    setNotice(null);
    if (!form.name.trim()) return setError('Enter the company name');

    setBusy(true);
    try {
      if (form.id) {
        await api(`/catalog/companies/${form.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            name: form.name.trim(),
            contactPerson: form.contactPerson.trim() || null,
            phone: form.phone.trim() || null,
            address: form.address.trim() || null,
            notes: form.notes.trim() || null,
            isActive: form.isActive,
          }),
        });
        setNotice(`${form.name.trim()} updated`);
      } else {
        await api('/catalog/companies', {
          method: 'POST',
          body: JSON.stringify({
            name: form.name.trim(),
            contactPerson: form.contactPerson.trim() || undefined,
            phone: form.phone.trim() || undefined,
            address: form.address.trim() || undefined,
            notes: form.notes.trim() || undefined,
          }),
        });
        setNotice(`${form.name.trim()} added`);
      }
      setForm(null);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the company');
    } finally {
      setBusy(false);
    }
  }

  async function remove(c: CompanyRow) {
    setError(null);
    setNotice(null);
    if (!window.confirm(`Delete ${c.name}? This cannot be undone.`)) return;

    setBusy(true);
    try {
      await api(`/catalog/companies/${c.id}`, { method: 'DELETE' });
      setNotice(`${c.name} deleted`);
      if (selected?.id === c.id) setSelected(null);
      await refresh();
    } catch (e) {
      // The server's message names the actual blocker, so surface it verbatim.
      setError(e instanceof Error ? e.message : 'Could not delete the company');
    } finally {
      setBusy(false);
    }
  }

  async function exportLog(slug: string, label: string) {
    if (!selected) return;
    setError(null);
    setExporting(slug);
    try {
      await downloadReport(slug, { companyId: selected.id });
      setNotice(`${label} downloaded.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Download failed');
    } finally {
      setExporting(null);
    }
  }

  async function toggleActive(c: CompanyRow) {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      await api(`/catalog/companies/${c.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive: c.is_active !== 1 }),
      });
      setNotice(c.is_active === 1 ? `${c.name} deactivated` : `${c.name} reactivated`);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not update the company');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="billing" style={{ gridTemplateColumns: selected ? '1fr 1fr' : '1fr' }}>
      <div>
        <div className="card">
          <div className="row wrap">
            <h2 style={{ margin: 0 }}>Companies</h2>
            <div className="grow" />
            <button className="btn" onClick={startNew}>+ New company</button>
          </div>
          <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
            The suppliers you buy from. A company can be deactivated at any time; it can only be
            deleted while nothing in the books refers to it.
          </p>
          {notice && <div className="alert success">{notice}</div>}
        </div>

        {form && (
          <div className="card">
            <h2>{form.id ? 'Edit company' : 'New company'}</h2>
            <div className="form-grid">
              <div className="span-2">
                <label className="muted" style={{ fontSize: 12 }}>Name</label>
                <input
                  className="input"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="e.g. Engro"
                  autoFocus
                />
              </div>
              <div>
                <label className="muted" style={{ fontSize: 12 }}>Contact person</label>
                <input
                  className="input"
                  value={form.contactPerson}
                  onChange={(e) => setForm({ ...form, contactPerson: e.target.value })}
                />
              </div>
              <div>
                <label className="muted" style={{ fontSize: 12 }}>Phone</label>
                <input
                  className="input"
                  value={form.phone}
                  onChange={(e) => setForm({ ...form, phone: e.target.value })}
                  inputMode="tel"
                />
              </div>
              <div className="span-2">
                <label className="muted" style={{ fontSize: 12 }}>Address</label>
                <input
                  className="input"
                  value={form.address}
                  onChange={(e) => setForm({ ...form, address: e.target.value })}
                />
              </div>
              <div className="span-2">
                <label className="muted" style={{ fontSize: 12 }}>Notes</label>
                <input
                  className="input"
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  placeholder="scheme terms, delivery days…"
                />
              </div>
              {form.id && (
                <div className="span-2">
                  <label className="row" style={{ gap: 8 }}>
                    <input
                      type="checkbox"
                      checked={form.isActive}
                      onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
                    />
                    <span>
                      Active
                      <span className="muted" style={{ display: 'block', fontSize: 12 }}>
                        Inactive companies disappear from the purchase and payment dropdowns. Their
                        history is untouched.
                      </span>
                    </span>
                  </label>
                </div>
              )}
            </div>

            {error && <div className="alert error" style={{ marginTop: 12 }}>{error}</div>}

            <div className="row" style={{ marginTop: 12 }}>
              <button className="btn" onClick={save} disabled={busy}>
                {busy ? 'Saving…' : form.id ? 'Save changes' : 'Add company'}
              </button>
              <button className="btn secondary" onClick={() => setForm(null)} disabled={busy}>
                Cancel
              </button>
            </div>
          </div>
        )}

        <div className="card">
          {(companies.data?.companies ?? []).length === 0 ? (
            <p className="muted">No companies yet. Use + New company above.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Company</th>
                  <th className="num" />
                </tr>
              </thead>
              <tbody>
                {companies.data!.companies.map((c) => (
                  <tr
                    key={c.id}
                    onClick={() => setSelected(c)}
                    style={{ cursor: 'pointer', background: selected?.id === c.id ? 'var(--green-50)' : undefined }}
                  >
                    <td>
                      {c.name}
                      {c.is_active !== 1 && <span className="badge void" style={{ marginLeft: 6 }}>inactive</span>}
                      <div className="muted" style={{ fontSize: 12 }}>
                        {[c.contact_person, c.phone].filter(Boolean).join(' · ') || 'no contact recorded'}
                      </div>
                    </td>
                    <td className="num">
                      <button
                        className="btn secondary sm"
                        onClick={(e) => { e.stopPropagation(); setSelected(c); startEdit(c); }}
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
                  {selected.is_active !== 1 && <span className="badge void" style={{ marginLeft: 8 }}>inactive</span>}
                </h2>
                <div className="muted">
                  {[selected.contact_person, selected.phone].filter(Boolean).join(' · ') || 'No contact recorded'}
                </div>
              </div>
              <button className="btn secondary sm" onClick={() => setSelected(null)}>Close</button>
            </div>
          </div>

          <div className="card">
            <h2>What this company owns</h2>
            {usage.isLoading ? (
              <p className="muted">Checking…</p>
            ) : !usage.data ? (
              <p className="muted">Could not read usage.</p>
            ) : (
              <>
                <table>
                  <tbody>
                    <tr>
                      <td className="muted">Outstanding payable</td>
                      <td className="num mono">
                        {usage.data.usage.balancePaisa === 0
                          ? '— settled —'
                          : usage.data.usage.balancePaisa > 0
                            ? `Rs ${(usage.data.usage.balancePaisa / 100).toLocaleString('en-IN')}`
                            : `Rs ${(-usage.data.usage.balancePaisa / 100).toLocaleString('en-IN')} (they owe you)`}
                      </td>
                    </tr>
                    <tr>
                      <td className="muted">Products</td>
                      <td className="num mono">{usage.data.usage.products}</td>
                    </tr>
                    <tr>
                      <td className="muted">Purchases / returns</td>
                      <td className="num mono">
                        {usage.data.usage.purchases} / {usage.data.usage.purchaseReturns}
                      </td>
                    </tr>
                    <tr>
                      <td className="muted">Payments made</td>
                      <td className="num mono">{usage.data.usage.payments}</td>
                    </tr>
                    <tr>
                      <td className="muted">Ledger entries</td>
                      <td className="num mono">{usage.data.usage.ledgerEntries}</td>
                    </tr>
                  </tbody>
                </table>

                {!usage.data.usage.canDelete && (
                  <div className="alert warn" style={{ marginTop: 12 }}>
                    <strong>This company cannot be deleted.</strong>{' '}
                    {(usage.data.usage.blockedBy ?? '').replace(/\.$/, '')}.
                    <div style={{ marginTop: 4 }}>
                      Deactivate it instead — it disappears from new purchases, and the books keep
                      their history.
                    </div>
                  </div>
                )}

                <div className="row wrap" style={{ marginTop: 12 }}>
                  <button
                className="btn secondary"
                disabled={exporting !== null}
                onClick={() => exportLog('company-history', 'Company history')}
                title="Download this company's whole history as Excel"
              >
                {exporting === 'company-history' ? '…' : 'History'}
              </button>
              <button className="btn secondary" onClick={() => toggleActive(selected)} disabled={busy}>
                    {selected.is_active === 1 ? 'Deactivate' : 'Reactivate'}
                  </button>
                  <button
                    className="btn danger"
                    onClick={() => remove(selected)}
                    disabled={busy || !usage.data.usage.canDelete}
                    title={usage.data.usage.canDelete ? 'Delete this company' : usage.data.usage.blockedBy ?? undefined}
                  >
                    Delete company
                  </button>
                </div>
                {error && <div className="alert error" style={{ marginTop: 12 }}>{error}</div>}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
