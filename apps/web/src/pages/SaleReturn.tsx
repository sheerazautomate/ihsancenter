import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, type PostedSaleReturn, type ReturnableInvoice, type ReturnableLine } from '../lib/api';
import { formatPkr, formatQty, parseNumber } from '../lib/money';

type Qty = Record<string, string>;

/**
 * Return goods from a customer.
 *
 * Reached from the invoice, because a return only makes sense against a bill: the
 * shop has to know what was sold, at what price, and how much of it has already
 * come back. Quantity inputs start empty rather than at "everything you sold",
 * because a return is the exception and a pre-filled number gets submitted by
 * accident.
 *
 * The refund is split between cash and a credit note. A credit note reduces the
 * farmer's udhaar; it cannot take his balance below zero, so the screen caps it at
 * what he owes and shows how the rest would be settled in cash.
 */
export default function SaleReturnPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [qty, setQty] = useState<Qty>({});
  const [reason, setReason] = useState('');
  const [docDate, setDocDate] = useState(() => new Date().toLocaleDateString('en-CA'));
  const [creditNote, setCreditNote] = useState('');
  const [refundCash, setRefundCash] = useState('');
  const [fullyReturned, setFullyReturned] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const data = useQuery({
    queryKey: ['returnable', id],
    queryFn: () => api<ReturnableInvoice>(`/sales/${id}/returnable`),
    enabled: !!id,
  });

  const lines = data.data?.lines ?? [];
  const owed = data.data?.owedByCustomerPaisa ?? 0;

  // What the ticked quantities are worth, at the prices on the invoice.
  const valuePaisa = lines.reduce((sum, l) => {
    const q = Math.round(parseNumber(qty[l.id] ?? '') * 1000);
    if (!q || q <= 0) return sum;
    return sum + Math.round((q * l.rate_paisa) / 1000) - Math.round((q * l.discount_paisa) / 1000);
  }, 0);

  // Most of it can go against the udhaar; past that the shop owes money back.
  const maxCredit = Math.min(owed, valuePaisa);
  const suggestedCredit = fullyReturned ? maxCredit : Math.min(valuePaisa, owed);
  const cashNeeded = Math.max(0, valuePaisa - suggestedCredit);

  // Keep the split in step with the basket until the manager overrides it.
  useEffect(() => {
    setCreditNote(String(suggestedCredit / 100));
    setRefundCash(String(cashNeeded / 100));
  }, [suggestedCredit, cashNeeded]);

  const creditPaisa = Math.round(parseNumber(creditNote) * 100);
  const cashPaisa = Math.round(parseNumber(refundCash) * 100);
  const remainder = valuePaisa - creditPaisa - cashPaisa;

  function setQtyFor(line: ReturnableLine, value: string) {
    setQty((prev) => ({ ...prev, [line.id]: value }));
  }

  async function submit() {
    if (!data.data) return;
    setError(null);

    const chosen = lines
      .map((l) => ({ line: l, q: Math.round(parseNumber(qty[l.id] ?? '') * 1000) }))
      .filter((x) => x.q > 0);

    if (chosen.length === 0) return setError('Enter how many of something are coming back');
    if (reason.trim().length < 3) return setError('Give a reason — the shop needs to explain this later');
    if (remainder !== 0) {
      return setError(
        `The refund is off by ${formatPkr(Math.abs(remainder))}. Credit note plus cash must equal ${formatPkr(valuePaisa)}.`,
      );
    }

    const over = chosen.find((x) => x.q > x.line.returnable_milli);
    if (over) {
      return setError(
        `Only ${formatQty(over.line.returnable_milli)} of ${over.line.product_name} can still come back`,
      );
    }

    setBusy(true);
    try {
      const res = await api<PostedSaleReturn>('/sales/returns', {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({
          customerId: data.data.invoice.customer_id,
          invoiceId: data.data.invoice.id,
          docDate,
          lines: chosen.map((x) => ({
            productId: x.line.product_id,
            qty: x.q / 1000,
            rate: x.line.rate_paisa / 100,
            discount: x.line.discount_paisa / 100,
          })),
          creditNote: creditPaisa / 100,
          refundCash: cashPaisa / 100,
          cashAccountId: 'ca_counter',
          reason: reason.trim(),
        }),
      });

      await queryClient.invalidateQueries({ queryKey: ['invoice', id] });
      await queryClient.invalidateQueries({ queryKey: ['returnable', id] });
      await queryClient.invalidateQueries({ queryKey: ['invoices'] });
      await queryClient.invalidateQueries({ queryKey: ['stock'] });
      await queryClient.invalidateQueries({ queryKey: ['customers'] });
      await queryClient.invalidateQueries({ queryKey: ['customer-ledger'] });
      await queryClient.invalidateQueries({ queryKey: ['dashboard'] });

      navigate(`/invoices/${id}?returned=${encodeURIComponent(res.returnNo)}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not record the return');
    } finally {
      setBusy(false);
    }
  }

  if (data.isLoading) return <p className="muted">Loading…</p>;
  if (!data.data) return <p className="muted">Invoice not found.</p>;

  const inv = data.data.invoice;
  const nothingLeft = lines.every((l) => l.returnable_milli === 0);

  return (
    <div style={{ maxWidth: 760, margin: '0 auto' }}>
      <div className="card">
        <div className="row wrap">
          <div className="grow">
            <h2 style={{ margin: 0 }}>Return goods — {inv.invoice_no}</h2>
            <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>
              {inv.customer_name} · sold {inv.doc_date} · owes{' '}
              <strong>{formatPkr(owed)}</strong>
            </div>
          </div>
          <Link className="btn secondary sm" to={`/invoices/${id}`}>Cancel</Link>
        </div>
      </div>

      {!data.data.canReturn ? (
        <div className="card">
          <div className="alert warn">
            This invoice was voided, so there is nothing to return against it.
          </div>
        </div>
      ) : nothingLeft ? (
        <div className="card">
          <div className="alert warn">
            Everything on this invoice has already been returned.
          </div>
        </div>
      ) : (
        <>
          <div className="card">
            <h2>What is coming back</h2>
            <table>
              <thead>
                <tr>
                  <th>Product</th>
                  <th className="num">Sold</th>
                  <th className="num">Already back</th>
                  <th className="num">Can return</th>
                  <th className="num">Returning</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.id} style={{ opacity: l.returnable_milli === 0 ? 0.45 : 1 }}>
                    <td>
                      {l.product_name}
                      <div className="muted" style={{ fontSize: 12 }}>
                        {formatPkr(l.rate_paisa)} / {l.unit}
                      </div>
                    </td>
                    <td className="num mono">{formatQty(l.qty_milli)}</td>
                    <td className="num mono">{l.returned_milli ? formatQty(l.returned_milli) : '—'}</td>
                    <td className="num mono">{formatQty(l.returnable_milli)}</td>
                    <td className="num">
                      <input
                        className="input right"
                        inputMode="decimal"
                        placeholder="0"
                        style={{ maxWidth: 90 }}
                        disabled={l.returnable_milli === 0}
                        value={qty[l.id] ?? ''}
                        onChange={(e) => setQtyFor(l, e.target.value)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="row" style={{ marginTop: 10 }}>
              <div className="grow" />
              <span className="muted" style={{ fontSize: 13 }}>Value of the return</span>
              <strong className="mono" style={{ marginLeft: 8 }}>{formatPkr(valuePaisa)}</strong>
            </div>
          </div>

          <div className="card">
            <h2>How it is settled</h2>
            <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
              A credit note reduces the udhaar. It cannot take the balance below zero, so
              anything beyond what is owed is refunded as cash.
            </p>
            <label className="row" style={{ gap: 8, marginBottom: 10 }}>
              <input
                type="checkbox"
                checked={fullyReturned}
                onChange={(e) => setFullyReturned(e.target.checked)}
              />
              <span>He has already paid this bill in full — give the money back</span>
            </label>
            <div className="split-pay">
              <div>
                <label className="muted" style={{ fontSize: 12 }}>
                  Against udhaar (max {formatPkr(maxCredit)})
                </label>
                <input
                  className="input right"
                  inputMode="decimal"
                  value={creditNote}
                  onChange={(e) => {
                    const v = Math.round(parseNumber(e.target.value) * 100);
                    setCreditNote(e.target.value);
                    // Whatever is not credited is refunded, so the two always add up.
                    setRefundCash(v <= valuePaisa ? String((valuePaisa - v) / 100) : '0');
                  }}
                />
              </div>
              <div>
                <label className="muted" style={{ fontSize: 12 }}>Cash refunded</label>
                <input
                  className="input right"
                  inputMode="decimal"
                  value={refundCash}
                  onChange={(e) => {
                    const v = Math.round(parseNumber(e.target.value) * 100);
                    setRefundCash(e.target.value);
                    setCreditNote(v <= valuePaisa ? String((valuePaisa - v) / 100) : '0');
                  }}
                />
              </div>
            </div>
            <div className="line credit" style={{ marginTop: 10 }}>
              <span>Credit note {formatPkr(creditPaisa)} + cash {formatPkr(cashPaisa)}</span>
              <span className={remainder === 0 ? 'muted' : ''} style={{ color: remainder === 0 ? undefined : 'var(--red-600)' }}>
                {remainder === 0 ? '= return value' : `off by ${formatPkr(Math.abs(remainder))}`}
              </span>
            </div>
          </div>

          <div className="card">
            <h2>Reason and date</h2>
            <div className="split-pay">
              <div>
                <label className="muted" style={{ fontSize: 12 }}>Date of return</label>
                <input
                  className="input"
                  type="date"
                  value={docDate}
                  onChange={(e) => setDocDate(e.target.value)}
                />
              </div>
              <div>
                <label className="muted" style={{ fontSize: 12 }}>Reason</label>
                <input
                  className="input"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="wrong product, unused, damaged…"
                />
              </div>
            </div>

            {error && <div className="alert error" style={{ marginTop: 12 }}>{error}</div>}

            <button
              className="btn block"
              style={{ marginTop: 12, padding: 14 }}
              disabled={busy || valuePaisa === 0}
              onClick={submit}
            >
              {busy ? 'Saving…' : `Record return of ${formatPkr(valuePaisa)}`}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
