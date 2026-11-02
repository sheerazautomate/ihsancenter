import { useEffect, useState } from 'react';
import { NavLink, Route, Routes, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './lib/api';
import LoginPage from './pages/Login';
import BillingPage from './pages/Billing';
import InvoicesPage from './pages/Invoices';
import InvoiceDetailPage from './pages/InvoiceDetail';
import StockPage from './pages/Stock';
import CustomersPage from './pages/Customers';

export interface CurrentUser {
  id: string;
  name: string;
  role: string;
}

export default function App() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['me'],
    queryFn: () => api<{ user: CurrentUser }>('/auth/me'),
    retry: false,
  });

  if (isLoading) {
    return (
      <div className="login-wrap">
        <div className="muted">Loading…</div>
      </div>
    );
  }

  if (error || !data) {
    return <LoginPage />;
  }

  return <Shell user={data.user} />;
}

function Shell({ user }: { user: CurrentUser }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [online, setOnline] = useState(navigator.onLine);

  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);

  async function signOut() {
    await api('/auth/logout', { method: 'POST' });
    queryClient.clear();
    navigate('/');
    window.location.reload();
  }

  return (
    <div className="app">
      <header className="topbar no-print">
        <div className="brand">
          Ihsan Center
          <small>Pesticides · Accounts</small>
        </div>
        <nav className="tabs">
          <NavLink to="/" end className={({ isActive }) => `tab ${isActive ? 'active' : ''}`}>
            Billing
          </NavLink>
          <NavLink to="/invoices" className={({ isActive }) => `tab ${isActive ? 'active' : ''}`}>
            Invoices
          </NavLink>
          <NavLink to="/stock" className={({ isActive }) => `tab ${isActive ? 'active' : ''}`}>
            Stock
          </NavLink>
          <NavLink to="/customers" className={({ isActive }) => `tab ${isActive ? 'active' : ''}`}>
            Customers
          </NavLink>
        </nav>
        <div className="spacer" />
        {!online && <span className="badge void">Offline</span>}
        <span className="muted" style={{ color: 'rgba(255,255,255,0.75)' }}>
          {user.name}
        </span>
        <button className="btn secondary sm" onClick={signOut}>
          Sign out
        </button>
      </header>

      <main className="content">
        <Routes>
          <Route path="/" element={<BillingPage />} />
          <Route path="/invoices" element={<InvoicesPage />} />
          <Route path="/invoices/:id" element={<InvoiceDetailPage />} />
          <Route path="/stock" element={<StockPage />} />
          <Route path="/customers" element={<CustomersPage />} />
        </Routes>
      </main>
    </div>
  );
}
