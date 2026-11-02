import { apiUrl } from './api';

/**
 * Download a report as a file.
 *
 * Fetches with the session cookie, then hands the bytes to the browser as a blob.
 * A plain `<a href>` would also work, but a failed request would navigate the
 * user to a page of JSON instead of telling them what went wrong -- and a manager
 * who has just clicked "Download" for a customer's history needs to know whether
 * it was empty or broken.
 */
export async function downloadReport(
  slug: string,
  opts: { customerId?: string; companyId?: string; format?: 'xlsx' | 'xls' | 'csv' | 'tsv' } = {},
): Promise<void> {
  const params = new URLSearchParams();
  if (opts.customerId) params.set('customerId', opts.customerId);
  if (opts.companyId) params.set('companyId', opts.companyId);
  if (opts.format) params.set('format', opts.format);

  const url = apiUrl(`/reports/export/${slug}${params.toString() ? `?${params}` : ''}`);
  const res = await fetch(url, { credentials: 'include' });

  if (!res.ok) {
    // The API answers JSON errors; anything else means we hit the asset handler.
    let message = `Download failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* keep the status-code message */
    }
    throw new Error(message);
  }

  const disposition = res.headers.get('Content-Disposition') ?? '';
  const match = /filename="([^"]+)"/.exec(disposition);
  const fallback = `ihsan_${slug}.xlsx`;
  const filename = match?.[1] ?? fallback;

  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoking immediately can cancel the download in some browsers; one tick is
  // enough for the click to have been consumed.
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}
