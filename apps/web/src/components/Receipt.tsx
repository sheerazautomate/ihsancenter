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
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {payment && payment.receipts.length > 0 && (
        <div style={{ fontSize: 11, marginTop: 8 }}>
          <strong>Payments received</strong>
          {payment.receipts.map((r) => (
            <div key={r.receipt_no} className="muted">
              {r.doc_date} · {r.receipt_no} · {r.mode} · {formatPkr(r.amount_paisa)}
            </div>
          ))}
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
