import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type OpeningInput, type OpeningResult, type OpeningState } from '../lib/api';
import { formatPkr, formatQty, paisaToInput, parseNumber } from '../lib/money';

/**
 * Opening balances.
 *
 * The one screen where the shop tells the system what already exists: what each
 * customer owes, what each company is owed, how much money is in the drawer and
 * the bank, and what is on the shelf. Everything it posts is double entry, so the
 * difference is the owner's capital — shown live, so the manager sees the figure
 * they are declaring instead of meeting it later in a report.
 *
 * Accounts that already carry an opening are shown as text with their posted
 * figure: the server refuses to post them twice, and this screen says so before
 * the manager types anything.
 */
export default function OpeningPage() {
  const queryClient = useQueryClient();
  const today = new Date().toISOString().slice(0, 10);

  const state = useQuery({
    queryKey: ['opening'],
    queryFn: () => api<OpeningState>('/opening'),
  });

  const [docDate, setDocDate] = useState(today);
  const [notes, setNotes] = useState('');
  /** Draft values, keyed `c:`, `s:`, `a:` for money rows and `p:` for stock. */
  const [money, setMoney] = useState<Record<string, string>>({});
  const [qty, setQty] = useState<Record<string, string>>({});
  const [cost, setCost] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<OpeningResult | null>(null);
  const [busy, setBusy] = useState(false);

  const s = state.data;

  /** Ids that already carry an opening balance — locked on the screen. */
  const locked = useMemo(() => {
    const set = new Set<string>();
    if (!s) return set;
    for (const r of s.customers) if (r.amountPaisa) set.add(`c:${r.id}`);
    for (const r of s.suppliers) if (r.amountPaisa) set.add(`s:${r.id}`);
    for (const r of s.cash) if (r.amountPaisa) set.add(`a:${r.id}`);
    for (const r of s.stock) if (r.qtyMilli) set.add(`p:${r.id}`);
    return set;
  }, [s]);

  // Pre-fill with whatever is already posted, so an already-open shop does not
  // see an empty form and wonder where its balances went.
  useEffect(() => {
    if (!s) return;
    const m: Record<string, string> = {};
    const q: Record<string, string> = {};
    const c: Record<string, string> = {};
    for (const r of s.customers) if (r.amountPaisa) m[`c:${r.id}`] = paisaToInput(r.amountPaisa);
    for (const r of s.suppliers) if (r.amountPaisa) m[`s:${r.id}`] = paisaToInput(r.amountPaisa);
    for (const r of s.cash) if (r.amountPaisa) m[`a:${r.id}`] = paisaToInput(r.amountPaisa);
    for (const r of s.stock) {
      if (r.qtyMilli) {
        q[r.id] = String(r.qtyMilli / 1000);
        c[r.id] = paisaToInput(r.unitCostPaisa);
      }
    }
    setMoney(m);
    setQty(q);
    setCost(c);
    if (s.firstOpeningDate) setDocDate(s.firstOpeningDate);
  }, [s]);

  /**
   * Live totals in paisa. Rows that are already posted are included from the
   * server figures, so the panel always describes the shop's true position.
   */
  const totals = useMemo(() => {
    const hundreds = (key: string) => Math.round(parseNumber(money[key] ?? '') * 100);
    const receivable = (s?.customers ?? []).reduce(
      (sum, r) => sum + (locked.has(`c:${r.id}`) ? r.amountPaisa : hundreds(`c:${r.id}`)),
      0,
    );
    const payable = (s?.suppliers ?? []).reduce(
      (sum, r) => sum + (locked.has(`s:${r.id}`) ? r.amountPaisa : hundreds(`s:${r.id}`)),
      0,
    );
    const cash = (s?.cash ?? []).reduce(
      (sum, r) => sum + (locked.has(`a:${r.id}`) ? r.amountPaisa : hundreds(`a:${r.id}`)),
      0,
    );
    const inventory = (s?.stock ?? []).reduce((sum, r) => {
      if (locked.has(`p:${r.id}`)) {
        return sum + Math.round((r.qtyMilli * r.unitCostPaisa) / 1000);
      }
      const units = parseNumber(qty[r.id] ?? '');
      const perUnit = Math.round(parseNumber(cost[r.id] ?? '') * 100);
      return sum + Math.round(units * perUnit);
    }, 0);
    // Assets minus liabilities. Negative means the shop owes more than it holds.
    return {
      receivable,
      payable,
      cash,
      inventory,
      capital: receivable + cash + inventory - payable,
    };
  }, [s, locked, money, qty, cost]);

  /** Rows the manager has actually filled in but not yet posted. */
  const pending = useMemo(() => {
    const input: OpeningInput = { docDate };
    const customers = (s?.customers ?? [])
      .filter((r) => !locked.has(`c:${r.id}`) && parseNumber(money[`c:${r.id}`] ?? ''))
      .map((r) => ({ customerId: r.id, amount: parseNumber(money[`c:${r.id}`] ?? '') }));
    const suppliers = (s?.suppliers ?? [])
      .filter((r) => !locked.has(`s:${r.id}`) && parseNumber(money[`s:${r.id}`] ?? ''))
      .map((r) => ({ companyId: r.id, amount: parseNumber(money[`s:${r.id}`] ?? '') }));
    const cash = (s?.cash ?? [])
      .filter((r) => !locked.has(`a:${r.id}`) && parseNumber(money[`a:${r.id}`] ?? ''))
      .map((r) => ({ cashAccountId: r.id, amount: parseNumber(money[`a:${r.id}`] ?? '') }));
    const stock = (s?.stock ?? [])
      .filter((r) => !locked.has(`p:${r.id}`) && parseNumber(qty[r.id] ?? '') > 0)
      .map((r) => ({
        productId: r.id,
        qty: parseNumber(qty[r.id] ?? ''),
        unitCost: parseNumber(cost[r.id] ?? ''),
      }));

    if (customers.length) input.customers = customers;
    if (suppliers.length) input.suppliers = suppliers;
    if (cash.length) input.cash = cash;
    if (stock.length) input.stock = stock;
    if (notes) input.notes = notes;

    const count = customers.length + suppliers.length + cash.length + stock.length;
    return { input, count };
  }, [s, locked, money, qty, cost, notes, docDate]);

  async function submit() {
    setError(null);
    setDone(null);
    if (pending.count === 0) return setError('Enter at least one balance before posting.');

    setBusy(true);
    try {
      // No Idempotency-Key here on purpose: each account may be opened exactly
      // once, so a double-tap cannot post twice — the second attempt is refused
      // by the same guard that protects the books.
      const result = await api<OpeningResult>('/opening', {
        method: 'POST',
        body: JSON.stringify(pending.input),
      });
      setDone(result);
      await queryClient.invalidateQueries();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not post opening balances');
    } finally {
      setBusy(false);
    }
  }

  if (state.isLoading) return <div className="muted">Loading…</div>;
  if (state.error) return <div className="alert error">{String(state.error)}</div>;
  if (!s) return null;

  return (
    <div className="opening">
      <div className="card">
        <h2>Opening balances</h2>
        <p className="muted">
          Enter what the shop holds on the day it starts using this system. Each account can be
          opened once — after that, use sales, purchases and receipts as normal.
        </p>

        {s.posted && (
          <div className="alert warn">
            Opening balances were posted on <strong>{s.firstOpeningDate}</strong>. Figures already
            recorded are locked; only new accounts can be added here.
          </div>
        )}

        <div className="row wrap">
          <div>
            <label className="muted" style={{ fontSize: 12 }}>
              Opening date
            </label>
            <input
              className="input"
              type="date"
              value={docDate}
              onChange={(e) => setDocDate(e.target.value)}
              disabled={s.posted}
            />
          </div>
          <div className="grow">
            <label className="muted" style={{ fontSize: 12 }}>
              Note (optional)
            </label>
            <input
              className="input"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. copied from the old khata"
            />
          </div>
        </div>
      </div>

      <div className="opening-grid">
        <div className="card">
          <h2>Customers owe the shop</h2>
          <p className="muted">
            Positive: the customer owes you (udhaar). Negative: you are holding their advance.
          </p>
          <table className="table">
            <thead>
              <tr>
                <th>Customer</th>
                <th className="num">Amount (Rs)</th>
              </tr>
            </thead>
            <tbody>
              {s.customers.map((r) => (
                <tr key={r.id} className={locked.has(`c:${r.id}`) ? 'locked' : undefined}>
                  <td>
                    {r.name}
                    {r.phone && <span className="muted"> · {r.phone}</span>}
                  </td>
                  <td className="num">
                    {locked.has(`c:${r.id}`) ? (
                      formatPkr(r.amountPaisa)
                    ) : (
                      <input
                        className="input"
                        inputMode="decimal"
                        value={money[`c:${r.id}`] ?? ''}
                        onChange={(e) =>
                          setMoney((prev) => ({ ...prev, [`c:${r.id}`]: e.target.value }))
                        }
                        placeholder="0"
                      />
                    )}
                  </td>
                </tr>
              ))}
              {s.customers.length === 0 && (
                <tr>
                  <td colSpan={2} className="muted">
                    No customers yet — add them on the Customers page first.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div>
          <div className="card">
            <h2>Owed to companies</h2>
            <p className="muted">
              Positive: you owe the company. Negative: the company owes you (advance or credit).
            </p>
            <table className="table">
              <thead>
                <tr>
                  <th>Company</th>
                  <th className="num">Amount (Rs)</th>
                </tr>
              </thead>
              <tbody>
                {s.suppliers.map((r) => (
                  <tr key={r.id} className={locked.has(`s:${r.id}`) ? 'locked' : undefined}>
                    <td>{r.name}</td>
                    <td className="num">
                      {locked.has(`s:${r.id}`) ? (
                        formatPkr(r.amountPaisa)
                      ) : (
                        <input
                          className="input"
                          inputMode="decimal"
                          value={money[`s:${r.id}`] ?? ''}
                          onChange={(e) =>
                            setMoney((prev) => ({ ...prev, [`s:${r.id}`]: e.target.value }))
                          }
                          placeholder="0"
                        />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="card">
            <h2>Cash and bank</h2>
            <table className="table">
              <thead>
                <tr>
                  <th>Account</th>
                  <th className="num">Balance (Rs)</th>
                </tr>
              </thead>
              <tbody>
                {s.cash.map((r) => (
                  <tr key={r.id} className={locked.has(`a:${r.id}`) ? 'locked' : undefined}>
                    <td>
                      {r.name} <span className="muted">({r.type})</span>
                    </td>
                    <td className="num">
                      {locked.has(`a:${r.id}`) ? (
                        formatPkr(r.amountPaisa)
                      ) : (
                        <input
                          className="input"
                          inputMode="decimal"
                          value={money[`a:${r.id}`] ?? ''}
                          onChange={(e) =>
                            setMoney((prev) => ({ ...prev, [`a:${r.id}`]: e.target.value }))
                          }
                          placeholder="0"
                        />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="card">
        <h2>Stock on the shelf</h2>
        <p className="muted">
          Quantity on hand and cost per unit. Stock already entered is locked — use Purchases from
          now on.
        </p>
        <table className="table">
          <thead>
            <tr>
              <th>Product</th>
              <th>Company</th>
              <th className="num">Quantity</th>
              <th className="num">Cost / unit (Rs)</th>
              <th className="num">Value</th>
            </tr>
          </thead>
          <tbody>
            {s.stock.map((r) => {
              const isLocked = locked.has(`p:${r.id}`);
              const value = isLocked
                ? Math.round((r.qtyMilli * r.unitCostPaisa) / 1000)
                : Math.round(
                    parseNumber(qty[r.id] ?? '') * Math.round(parseNumber(cost[r.id] ?? '') * 100),
                  );
              return (
                <tr key={r.id} className={isLocked ? 'locked' : undefined}>
                  <td>{r.name}</td>
                  <td className="muted">{r.companyName}</td>
                  <td className="num">
                    {isLocked ? (
                      formatQty(r.qtyMilli)
                    ) : (
                      <input
                        className="input"
                        inputMode="decimal"
                        value={qty[r.id] ?? ''}
                        onChange={(e) => setQty((prev) => ({ ...prev, [r.id]: e.target.value }))}
                        placeholder="0"
                      />
                    )}
                  </td>
                  <td className="num">
                    {isLocked ? (
                      formatPkr(r.unitCostPaisa)
                    ) : (
                      <input
                        className="input"
                        inputMode="decimal"
                        value={cost[r.id] ?? ''}
                        onChange={(e) => setCost((prev) => ({ ...prev, [r.id]: e.target.value }))}
                        placeholder="0"
                      />
                    )}
                  </td>
                  <td className="num">{formatPkr(value)}</td>
                </tr>
              );
            })}
            {s.stock.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">
                  No products yet — add them on the Stock page first.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="card opening-summary">
        <h2>What this declares</h2>
        <table className="table">
          <tbody>
            <tr>
              <td>Receivable from customers</td>
              <td className="num">{formatPkr(totals.receivable)}</td>
            </tr>
            <tr>
              <td>Cash and bank</td>
              <td className="num">{formatPkr(totals.cash)}</td>
            </tr>
            <tr>
              <td>Stock at cost</td>
              <td className="num">{formatPkr(totals.inventory)}</td>
            </tr>
            <tr>
              <td>Less: payable to companies</td>
              <td className="num">− {formatPkr(totals.payable)}</td>
            </tr>
            <tr className="total">
              <td>
                <strong>Owner's capital</strong>{' '}
                <span className="muted">
                  {totals.capital < 0 ? '(negative — liabilities exceed assets)' : '(balancing figure)'}
                </span>
              </td>
              <td className="num">
                <strong>{formatPkr(totals.capital)}</strong>
              </td>
            </tr>
          </tbody>
        </table>

        <button className="btn block" onClick={submit} disabled={busy || pending.count === 0}>
          {busy ? 'Posting…' : `Post opening balances${pending.count ? ` (${pending.count})` : ''}`}
        </button>

        {error && <div className="alert error">{error}</div>}
        {done && (
          <div className="alert success">
            Posted. Capital recorded: <strong>{formatPkr(done.totals.capitalPaisa)}</strong>
          </div>
        )}
      </div>
    </div>
  );
}
