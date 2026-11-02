import { formatPkr, formatQty } from '../lib/money';
import type { Invoice, InvoiceLine, InvoicePayment } from '../lib/api';

/**
 * Printable invoice.
 *
 * Plain CSS with `@page` — works on A5/A4 and, on a shop PC with the thermal
 * driver installed, on an 80mm roll. No PDF library, so no paid dependency:
 * the browser's own "Save as PDF" produces the WhatsApp-shareable copy.
 */
export default function Receipt({
  invoice,
  lines,
  payment,
}: {
  invoice: Invoice;
  lines: InvoiceLine[];
  payment?: InvoicePayment;
}) {
  return (
    <div className="receipt">
      <h1>Ihsan Center</h1>
      <div className="sub">Pesticides &amp; Agricultural Inputs</div>

      <div className="row" style={{ justifyContent: 'space-between', fontSize: 13 }}>
        <span>
          <strong>{invoice.invoice_no}</strong>
          <br />
          <span className="muted">{invoice.doc_date}</span>
        </span>
        <span style={{ textAlign: 'right' }}>
          <strong>{invoice.customer_name}</strong>
          <br />
          <span className="muted">
            {[invoice.customer_phone, invoice.customer_village].filter(Boolean).join(' · ')}
          </span>
        </span>
      </div>

      <hr />

      <table>
        <tbody>
          {lines.map((l) => (
            <tr key={l.id}>
              <td>
                {l.product_name}
                <div className="muted" style={{ fontSize: 11 }}>
                  {formatQty(l.qty_milli)} × {formatPkr(l.rate_paisa)}
                </div>
              </td>
              <td style={{ textAlign: 'right' }}>{formatPkr(l.line_total_paisa)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <hr />

      <table>
        <tbody>
          {invoice.discount_paisa > 0 && (
            <tr>
              <td>Discount</td>
              <td style={{ textAlign: 'right' }}>-{formatPkr(invoice.discount_paisa)}</td>
            </tr>
          )}
          <tr>
            <td>
              <strong>Total</strong>
            </td>
            <td style={{ textAlign: 'right', fontSize: 16 }}>
              <strong>{formatPkr(invoice.total_paisa)}</strong>
            </td>
          </tr>
          {invoice.paid_cash_paisa > 0 && (
            <tr>
              <td>Cash</td>
              <td style={{ textAlign: 'right' }}>{formatPkr(invoice.paid_cash_paisa)}</td>
            </tr>
          )}
          {invoice.paid_bank_paisa > 0 && (
            <tr>
              <td>Bank</td>
              <td style={{ textAlign: 'right' }}>{formatPkr(invoice.paid_bank_paisa)}</td>
            </tr>
          )}
          {invoice.credit_paisa > 0 && (
            <tr>
              <td>On credit (udhaar)</td>
              <td style={{ textAlign: 'right' }}>{formatPkr(invoice.credit_paisa)}</td>
            </tr>
          )}
          {/* Only shown once money has actually come in against this bill. A
              reprint used to state the full credit as though nothing had been
              paid, which is the one line a farmer checks. */}
          {payment && payment.settledPaisa > 0 && (
            <>
              <tr>
                <td>Received since</td>
                <td style={{ textAlign: 'right' }}>-{formatPkr(payment.settledPaisa)}</td>
              </tr>
              <tr>
                <td>
                  <strong>Still owed</strong>
                </td>
                <td style={{ textAlign: 'right', fontSize: 16 }}>
                  <strong>{formatPkr(payment.outstandingPaisa)}</strong>
                </td>
              </tr>
            </>
          )}
          {invoice.credit_paisa > 0 && payment && payment.outstandingPaisa === 0 && (
            <tr>
              <td colSpan={2} style={{ textAlign: 'center', fontWeight: 600 }}>
                PAID IN FULL
                {payment.clearedOn ? ` — ${payment.clearedOn}` : ''}
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {/* The dated payment history. This is what settles an argument: each date,
          what was handed over, and the balance it left. A single "received since"
          total cannot answer "on which date did I pay what". */}
      {payment && payment.history.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 3 }}>
            Payments against this bill
          </div>
          <table style={{ fontSize: 11 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>Date</th>
                <th style={{ textAlign: 'left' }}>Receipt</th>
                <th style={{ textAlign: 'left' }}>Mode</th>
                <th style={{ textAlign: 'right' }}>Paid</th>
                <th style={{ textAlign: 'right' }}>Balance</th>
              </tr>
            </thead>
            <tbody>
              {payment.history.map((h) => (
                <tr key={`${h.document}-${h.date}`}>
                  <td>{h.date}</td>
                  <td>{h.document}</td>
                  <td style={{ textTransform: 'capitalize' }}>{h.mode}</td>
                  <td style={{ textAlign: 'right' }}>
                    {formatPkr(h.amountPaisa)}
                    {h.refundPaisa && h.amountPaisa === 0 ? (
                      <div style={{ fontSize: 10 }} className="muted">
                        {formatPkr(h.refundPaisa)} refunded
                      </div>
                    ) : null}
                    {h.refundPaisa && h.amountPaisa > 0 ? (
                      <div style={{ fontSize: 10 }} className="muted">
                        + {formatPkr(h.refundPaisa)} cash back
                      </div>
                    ) : null}
                  </td>
                  <td style={{ textAlign: 'right' }}>{formatPkr(h.balanceAfterPaisa)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ fontSize: 10, marginTop: 3 }} className="muted">
            {payment.outstandingPaisa === 0
              ? `Cleared in full${payment.clearedOn ? ` on ${payment.clearedOn}` : ''}.`
              : `Still owed ${formatPkr(payment.outstandingPaisa)}${
                  payment.lastPaidOn ? ` after the last payment on ${payment.lastPaidOn}` : ''
                }.`}
          </div>
        </div>
      )}

      {invoice.status === 'void' && (
        <div className="alert error" style={{ marginTop: 12, textAlign: 'center' }}>
          VOIDED INVOICE
        </div>
      )}

      <hr />
      <div className="sub" style={{ marginBottom: 0 }}>
        Thank you — please keep this receipt
      </div>
    </div>
  );
}
