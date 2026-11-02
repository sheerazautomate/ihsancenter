import { describe, it, expect } from 'vitest';
import { apiUrl } from '../src/lib/api';

/**
 * The API lives at /api/* on the SPA's own origin, and every call goes through
 * `apiUrl`. This was shipped broken once: the helper's condition was inverted, so
 * the prefix was never applied and the browser requested `/auth/login`.
 *
 * In `vite dev` that 404s against the dev server and nobody notices. In production,
 * where one Worker serves both the assets and the API, it returns 405 (for a POST)
 * or the HTML app (for a GET) — so signing in failed and every screen looked
 * signed-out. These cases exist so the prefix cannot regress silently.
 */
describe('apiUrl', () => {
  it('prefixes the paths the pages actually pass', () => {
    expect(apiUrl('/auth/login')).toBe('/api/auth/login');
    expect(apiUrl('/auth/me')).toBe('/api/auth/me');
    expect(apiUrl('/catalog/stock')).toBe('/api/catalog/stock');
    expect(apiUrl('/opening')).toBe('/api/opening');
    expect(apiUrl('/reports/dashboard')).toBe('/api/reports/dashboard');
    expect(apiUrl('/money/expenses?from=2026-11-01&to=2026-11-30')).toBe(
      '/api/money/expenses?from=2026-11-01&to=2026-11-30',
    );
  });

  it('tolerates a path without a leading slash', () => {
    expect(apiUrl('auth/login')).toBe('/api/auth/login');
  });

  it('never double-prefixes a path that already carries /api', () => {
    expect(apiUrl('/api/auth/me')).toBe('/api/auth/me');
    expect(apiUrl('/api')).toBe('/api');
  });

  it('leaves absolute URLs alone', () => {
    expect(apiUrl('https://example.com/x')).toBe('https://example.com/x');
    expect(apiUrl('http://localhost:8787/health')).toBe('http://localhost:8787/health');
  });

  it('does not mistake a path containing "api" for an absolute URL', () => {
    expect(apiUrl('/catalog/apiary')).toBe('/api/catalog/apiary');
  });
});
