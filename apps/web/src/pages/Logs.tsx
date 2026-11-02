import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { downloadReport } from '../lib/export';

interface ReportRow {
  slug: string;
  title: string;
  description: string;
  group: string;
  scope: 'customer' | 'company' | null;
  columns: number;
}

interface CustomerRow {
  id: string;
  name: string;
  phone: string | null;
  village: string | null;
}

interface CompanyRow {
  id: string;
  name: string;
}

const GROUPS = ['Customers', 'Companies', 'Stock', 'Cash', 'Expenses', 'System'] as const;

/**
 * Logs and exports.
 *
 * Every report is served by one endpoint, and this page is driven by the API's
 * own catalogue -- so a report added on the server appears here with no change to
 * this file, and the two can never drift apart.
 *
 * The layout follows the way the shop asks the question: "give me everything
 * about this farmer" and "give me everything" are both one click.
 */
export default function LogsPage() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  // Which customer/company a scoped report is for.
  const [customerId, setCustomerId] = useState('');
  const [companyId, setCompanyId] = useState('');

  const reports = useQuery({
    queryKey: ['export-catalogue'],
    queryFn: () => api<{ reports: ReportRow[] }>('/reports/export'),
  });

  const customers = useQuery({
    queryKey: ['customers', 'list', ''],
    queryFn: () => api<{ customers: CustomerRow[] }>(`/customers?limit=100&all=1`),
  });

  const companies = useQuery({
    queryKey: ['companies-all'],
    queryFn: () => api<{ companies: CompanyRow[] }>('/catalog/companies?all=1'),
  });

  async function run(
    slug: string,
    label: string,
    opts: { customerId?: string; companyId?: string; format?: 'xlsx' | 'csv' } = {},
  ) {
    setBusy(slug);
    setError(null);
    setNotice(null);
    try {
      await downloadReport(slug, opts);
      setNotice(`${label} downloaded.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Download failed');
    } finally {
      setBusy(null);
    }
  }

  const all = reports.data?.reports ?? [];
  const q = search.trim().toLowerCase();
  const visible = q
    ? all.filter(
        (r) =>
          r.title.toLowerCase().includes(q) ||
          r.description.toLowerCase().includes(q) ||
          r.group.toLowerCase().includes(q),
      )
    : all;

  const customer = (customers.data?.customers ?? []).find((c) => c.id === customerId);
  const company = (companies.data?.companies ?? []).find((c) => c.id === companyId);

  return (
    <div>
      <div className="card">
        <div className="row wrap">
          <h2 style={{ margin: 0 }}>Logs &amp; exports</h2>
          <div className="grow" />
          <input
            className="input"
            placeholder="Search logs…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ maxWidth: 260 }}
          />
        </div>
        <p className="muted" style={{ fontSize: 13, marginTop: 6 }}>
          Every log in the system, downloadable as Excel. Amounts are in rupees, dates in
          YYYY-MM-DD, and voided documents are included and marked — the record has to show
          what was cancelled, not just what survived.
        </p>

        {error && <div className="alert error">{error}</div>}
        {notice && <div className="alert success">{notice}</div>}
      </div>

      {/* The one click the shop asked for. */}
      <div className="card" style={{ borderLeft: '4px solid var(--green-900)' }}>
        <div className="row wrap">
          <div className="grow">
            <h2 style={{ margin: 0 }}>Everything, in one file</h2>
            <p className="muted" style={{ fontSize: 13, margin: '6px 0 0' }}>
              One workbook with a sheet for every log below, plus a separate sheet for each
              customer and each company that has any movement. This is the file to keep, and
              the closest thing to a backup that exists today.
            </p>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button
              className="btn"
              disabled={busy !== null}
              onClick={() => run('everything/all', 'Full workbook')}
            >
              {busy === 'everything/all' ? 'Building…' : 'Download everything'}
            </button>
          </div>
        </div>
        <p className="muted" style={{ fontSize: 12, margin: '8px 0 0' }}>
          Grows with the shop; large data sets take a few seconds to assemble.
        </p>
      </div>

      {/* Per-person: pick one, then take every log for them. */}
      <div className="card">
        <h2>One customer, everything about them</h2>
        <div className="row wrap" style={{ gap: 8 }}>
          <select
            className="select"
            value={customerId}
            onChange={(e) => setCustomerId(e.target.value)}
            style={{ minWidth: 240 }}
          >
            <option value="">Choose a customer…</option>
            {(customers.data?.customers ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.village ? ` — ${c.village}` : ''}
              </option>
            ))}
          </select>
          {[
            ['customer-history', 'Full history'],
            ['customer-invoices', 'Invoices'],
            ['customer-items', 'Items bought'],
            ['customer-receipts', 'Receipts'],
          ].map(([slug, label]) => (
            <button
              key={slug}
              className="btn secondary"
              disabled={!customerId || busy !== null}
              onClick={() => run(slug, `${customer?.name ?? 'Customer'} — ${label}`, { customerId })}
            >
              {busy === slug ? '…' : label}
            </button>
          ))}
        </div>
        <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
          These same logs are also a button on the customer's own page.
        </p>
      </div>

      <div className="card">
        <h2>One company, everything about them</h2>
        <div className="row wrap" style={{ gap: 8 }}>
          <select
            className="select"
            value={companyId}
            onChange={(e) => setCompanyId(e.target.value)}
            style={{ minWidth: 240 }}
          >
            <option value="">Choose a company…</option>
            {(companies.data?.companies ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          {[
            ['company-history', 'Full history'],
            ['company-purchases', 'Purchases'],
            ['company-payments', 'Payments made'],
          ].map(([slug, label]) => (
            <button
              key={slug}
              className="btn secondary"
              disabled={!companyId || busy !== null}
              onClick={() => run(slug, `${company?.name ?? 'Company'} — ${label}`, { companyId })}
            >
              {busy === slug ? '…' : label}
            </button>
          ))}
        </div>
      </div>

      {reports.isLoading ? (
        <div className="card">
          <p className="muted">Loading the log catalogue…</p>
        </div>
      ) : visible.length === 0 ? (
        <div className="card">
          <p className="muted">No log matches “{search}”.</p>
        </div>
      ) : (
        GROUPS.map((group) => {
          const rows = visible.filter((r) => r.group === group);
          if (rows.length === 0) return null;
          return (
            <div className="card" key={group}>
              <h2>{group}</h2>
              <table>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.slug}>
                      <td>
                        <strong>{r.title}</strong>
                        <div className="muted" style={{ fontSize: 12 }}>
                          {r.description}
                        </div>
                      </td>
                      <td className="num" style={{ whiteSpace: 'nowrap' }}>
                        {r.scope ? (
                          <span className="muted" style={{ fontSize: 12 }}>
                            use the picker above
                          </span>
                        ) : (
                          <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                            <button
                              className="btn secondary sm"
                              disabled={busy !== null}
                              onClick={() => run(r.slug, r.title)}
                            >
                              {busy === r.slug ? '…' : 'Excel'}
                            </button>
                            <button
                              className="btn secondary sm"
                              disabled={busy !== null}
                              onClick={() => run(r.slug, r.title, { format: 'csv' })}
                              title="Plain CSV — for very large exports"
                            >
                              CSV
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        })
      )}
    </div>
  );
}
