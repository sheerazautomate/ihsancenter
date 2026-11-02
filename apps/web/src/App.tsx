import { useEffect, useState } from 'react';
import { NavLink, Route, Routes, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './lib/api';
import LoginPage from './pages/Login';
import DashboardPage from './pages/Dashboard';
import PurchasesPage from './pages/Purchases';
import ReceivablesPage from './pages/Receivables';
import ExpensesPage from './pages/Expenses';
import ReportsPage from './pages/Reports';
import BillingPage from './pages/Billing';
import InvoicesPage from './pages/Invoices';
import InvoiceDetailPage from './pages/InvoiceDetail';
import StockPage from './pages/Stock';
import CustomersPage from './pages/Customers';
import OpeningPage from './pages/Opening';
import CompaniesPage from './pages/Companies';

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
          {[
            ['/', 'Billing', true],
            ['/invoices', 'Invoices', false],
            ['/purchases', 'Purchases', false],
            ['/receivables', 'Udhaar', false],
            ['/customers', 'Customers', false],
            ['/companies', 'Companies', false],
            ['/stock', 'Stock', false],
            ['/expenses', 'Expenses', false],
            ['/reports', 'Reports', false],
            ['/opening', 'Opening', false],
            ['/dashboard', 'Dashboard', false],
          ].map(([path, label, end]) => (
            <NavLink
              key={path as string}
              to={path as string}
              end={end as boolean}
              className={({ isActive }) => `tab ${isActive ? 'active' : ''}`}
            >
              {label as string}
            </NavLink>
          ))}
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
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/purchases" element={<PurchasesPage />} />
          <Route path="/receivables" element={<ReceivablesPage />} />
          <Route path="/expenses" element={<ExpensesPage />} />
          <Route path="/reports" element={<ReportsPage />} />
          <Route path="/invoices" element={<InvoicesPage />} />
          <Route path="/invoices/:id" element={<InvoiceDetailPage />} />
          <Route path="/stock" element={<StockPage />} />
          <Route path="/customers" element={<CustomersPage />} />
          <Route path="/companies" element={<CompaniesPage />} />
          <Route path="/opening" element={<OpeningPage />} />
        </Routes>
      </main>
    </div>
  );
}
