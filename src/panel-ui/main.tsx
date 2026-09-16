import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth';
import { LoadingState, ToastProvider } from './ui';
import { Shell } from './shell';
import { Login } from './pages/Login';
import { ForcedPasswordChange } from './pages/ChangePassword';
import { Games } from './pages/Games';
import { GameDetail } from './pages/GameDetail';
import { StockTab } from './pages/StockTab';
import { SerialTab } from './pages/SerialTab';
import { KeysTab } from './pages/KeysTab';
import { WebhookTab } from './pages/WebhookTab';
import { RobloxTab } from './pages/RobloxTab';
import { ClientTab } from './pages/ClientTab';
import { FunnelTab } from './pages/FunnelTab';
import { FunnelDetail } from './pages/FunnelDetail';
import { Accounts } from './pages/Accounts';
import { MyAccount } from './pages/MyAccount';
import { NotFound } from './pages/NotFound';
import '@fontsource-variable/inter';
import './app.css';

function Booting() {
  return (
    <div className="login-shell">
      <LoadingState label="Starting…" />
    </div>
  );
}

/**
 * The one gate. Everything authenticated hangs off this, so the two states that must never be
 * bypassable — no session, and must-change-password — are enforced structurally rather than
 * remembered per screen.
 */
function RequireAuth() {
  const { session, loading } = useAuth();
  const location = useLocation();

  if (loading) return <Booting />;

  // `location` is react-router's, so it has ALREADY had the /panel basename stripped. Passing
  // it through state (not a ?next= built from window.location.pathname) is what keeps the
  // basename from being applied twice on the way back.
  if (!session) return <Navigate to="/login" state={{ from: location }} replace />;

  // Ahead of the Outlet, so no route below can render while the flag is set — which matches
  // the server, where every route except /auth/{me,logout,password} 403s until it clears.
  if (session.mustChangePassword) return <ForcedPasswordChange />;

  return <Outlet />;
}

/** Owner-only routes. UX only: an admin who types the URL gets 403s from the server anyway. */
function RequireOwner() {
  const { isOwner } = useAuth();
  return isOwner ? <Outlet /> : <Navigate to="/games" replace />;
}

function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route element={<RequireAuth />}>
        <Route element={<Shell />}>
          <Route index element={<Navigate to="/games" replace />} />
          <Route path="games" element={<Games />} />
          <Route path="games/:gameId" element={<GameDetail />}>
            <Route index element={<Navigate to="stock" replace />} />
            <Route path="stock" element={<StockTab />} />
            <Route path="serial" element={<SerialTab />} />
            <Route path="keys" element={<KeysTab />} />
            <Route path="webhook" element={<WebhookTab />} />
            <Route path="roblox" element={<RobloxTab />} />
            <Route path="client" element={<ClientTab />} />
            {/* Nested rather than two sibling paths, so the detail page's relative ".." lands
                on the list. In v6 ".." walks the route hierarchy, not the URL — as one flat
                "funnels/:funnelName" route it would climb past the list to the game. */}
            <Route path="funnels">
              <Route index element={<FunnelTab />} />
              <Route path=":funnelName" element={<FunnelDetail />} />
            </Route>
          </Route>
          <Route element={<RequireOwner />}>
            <Route path="accounts" element={<Accounts />} />
          </Route>
          <Route path="account" element={<MyAccount />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Route>
    </Routes>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('#root missing from index.html');

createRoot(root).render(
  <StrictMode>
    {/* Matches Vite's base and the plugin's mount point. react-router strips it from every
        location, so no screen ever has to know the panel is not at the origin root. */}
    <BrowserRouter basename="/panel">
      <ToastProvider>
        <AuthProvider>
          <App />
        </AuthProvider>
      </ToastProvider>
    </BrowserRouter>
  </StrictMode>,
);
