import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { api, ApiError, type Invoice, type InvoiceLine } from '../lib/api';
import Receipt from '../components/Receipt';

export default function InvoiceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['invoice', id],
    queryFn: () => api<{ invoice: Invoice; lines: InvoiceLine[] }>(`/sales/${id}`),
    enabled: !!id,
  });

  async function voidInvoice() {
    const reason = window.prompt('Reason for voiding this invoice (recorded permanently):');
    if (!reason || reason.trim().length < 3) return;

    setBusy(true);
    setError(null);
    try {
      await api(`/sales/${id}/void`, {
        method: 'POST',
        body: JSON.stringify({ reason: reason.trim() }),
      });
      await queryClient.invalidateQueries({ queryKey: ['invoice', id] });
      await queryClient.invalidateQueries({ queryKey: ['invoices'] });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not void the invoice');
    } finally {
      setBusy(false);
    }
  }

  if (isLoading) return <p className="muted">Loading…</p>;
  if (!data) return <p className="muted">Invoice not found.</p>;

  return (
    <div>
      <div className="no-print row" style={{ marginBottom: 12, maxWidth: 420, margin: '0 auto 12px' }}>
        <button className="btn secondary grow" onClick={() => window.print()}>
          Print
        </button>
        {data.invoice.status === 'open' && (
          <button className="btn danger" disabled={busy} onClick={voidInvoice}>
            {busy ? 'Voiding…' : 'Void invoice'}
          </button>
        )}
      </div>

      {error && (
        <div className="alert error no-print" style={{ maxWidth: 420, margin: '0 auto 12px' }}>
          {error}
        </div>
      )}

      <Receipt invoice={data.invoice} lines={data.lines} />
    </div>
  );
}
