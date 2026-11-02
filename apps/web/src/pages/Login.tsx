import { useState } from 'react';
import { api, ApiError } from '../lib/api';

export default function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      });
      // Full reload keeps the auth state resolution in one place.
      window.location.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not sign in');
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <div className="card login-card">
        <h2>Ihsan Center</h2>
        <p className="muted" style={{ marginTop: -6 }}>
          Sign in to manage sales and accounts
        </p>

        {error && <div className="alert error">{error}</div>}

        <form onSubmit={submit} style={{ display: 'grid', gap: 12 }}>
          <div>
            <label className="muted" htmlFor="username">
              Username
            </label>
            <input
              id="username"
              className="input"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoCapitalize="none"
              required
            />
          </div>
          <div>
            <label className="muted" htmlFor="password">
              Password
            </label>
            <input
              id="password"
              className="input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </div>
          <button className="btn block" type="submit" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
