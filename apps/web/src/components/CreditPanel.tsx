import { formatPkr } from '../lib/money';
import type { CreditPanel as CreditPanelData } from '../lib/api';

/**
 * The credit panel.
 *
 * This is the requirement that started the project: "each customer's credit can be
 * seen when issuing new order to that customer". It sits next to the bill and
 * updates as lines are added, so the manager never has to leave the screen to know
 * whether this sale will cross the limit.
 */
export default function CreditPanel({
  data,
  pendingPaisa,
}: {
  data: CreditPanelData;
  pendingPaisa: number;
}) {
  const projected = data.outstandingPaisa + pendingPaisa;
  const overLimit = data.hasLimit && projected > data.creditLimitPaisa;

  const tone = data.isCreditHold
    ? 'danger'
    : overLimit
      ? 'danger'
      : data.hasLimit && data.availablePaisa !== null && data.availablePaisa < data.creditLimitPaisa * 0.2
        ? 'warn'
        : 'ok';

  return (
    <div className={`credit-panel ${tone}`}>
      <div className="credit-headline">
        <div>
          <div className="muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }}>
            {data.hasLimit ? 'Available credit' : 'Outstanding (no limit set)'}
          </div>
          <div className="amount">
            {data.hasLimit
              ? formatPkr(data.creditLimitPaisa - projected, { decimals: false })
              : formatPkr(projected, { decimals: false })}
          </div>
        </div>
        {data.isCreditHold && <span className="badge void">Credit hold</span>}
      </div>

      <div className="credit-legend">
        <div>
          Limit
          <strong>{data.hasLimit ? formatPkr(data.creditLimitPaisa, { decimals: false }) : 'None'}</strong>
        </div>
        <div>
          Outstanding
          <strong>{formatPkr(data.outstandingPaisa, { decimals: false })}</strong>
        </div>
        {pendingPaisa > 0 && (
          <div>
            This bill
            <strong>{formatPkr(pendingPaisa, { decimals: false })}</strong>
          </div>
        )}
        {data.hasLimit && (
          <div>
            After this bill
            <strong>{formatPkr(projected, { decimals: false })}</strong>
          </div>
        )}
      </div>

      {(data.aging.d31to60 > 0 || data.aging.d61to90 > 0 || data.aging.d90plus > 0) && (
        <div className="aging">
          <div className="bucket">
            0–30 days
            <strong>{formatPkr(data.aging.d0to30, { decimals: false })}</strong>
          </div>
          <div className={`bucket ${data.aging.d31to60 > 0 ? 'hot' : ''}`}>
            31–60
            <strong>{formatPkr(data.aging.d31to60, { decimals: false })}</strong>
          </div>
          <div className={`bucket ${data.aging.d61to90 > 0 ? 'hot' : ''}`}>
            61–90
            <strong>{formatPkr(data.aging.d61to90, { decimals: false })}</strong>
          </div>
          <div className={`bucket ${data.aging.d90plus > 0 ? 'hot' : ''}`}>
            90+
            <strong>{formatPkr(data.aging.d90plus, { decimals: false })}</strong>
          </div>
        </div>
      )}

      {overLimit && (
        <div className="alert error" style={{ marginTop: 12, marginBottom: 0 }}>
          This bill takes the customer over their limit. Reduce the credit portion or override.
        </div>
      )}
    </div>
  );
}
