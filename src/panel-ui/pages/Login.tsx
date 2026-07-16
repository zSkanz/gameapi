import { useEffect, useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Layers } from 'lucide-react';
import { api, errorMessage, isApiError } from '../api';
import { useAuth } from '../auth';
import { Alert, Spinner } from '../ui';

interface FromState {
  from?: { pathname?: string; search?: string };
}

export function Login() {
  const { session, setSession, loading } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [retryIn, setRetryIn] = useState(0);

  // Tick the throttle window down rather than showing a frozen "try again in 900s".
  useEffect(() => {
    if (retryIn <= 0) return;
    const t = setTimeout(() => setRetryIn((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [retryIn]);

  if (loading) return null;

  // Bounced here mid-navigation: go back to where they were. `from` is a react-router
  // location, so its pathname has no /panel prefix — exactly what basename expects back.
  const from = (location.state as FromState | null)?.from;
  const target = from?.pathname ? `${from.pathname}${from.search ?? ''}` : '/games';
  if (session) return <Navigate to={target} replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const s = await api.login(username, password);
      setSession(s);
      // mustChangePassword is handled by RequireAuth, not here — one gate, not two.
      navigate(target, { replace: true });
    } catch (err) {
      setError(err);
      if (isApiError(err, 'PANEL_LOGIN_THROTTLED')) setRetryIn(err.retryAfter ?? 60);
      setPassword('');
    } finally {
      setBusy(false);
    }
  }

  const throttled = retryIn > 0;

  return (
    <div className="login-shell">
      <div className="login-card">
        <div className="login-brand">
          <span className="brand-mark" aria-hidden>
            <Layers size={20} />
          </span>
          <div>
            <div className="login-title">GameApi Panel</div>
            <div className="page-sub">Sign in to manage stock, serials and keys.</div>
          </div>
        </div>

        <form className="login-form" onSubmit={submit}>
          {error ? (
            <Alert kind={throttled ? 'warn' : 'danger'}>
              {errorMessage(error)}
              {throttled ? ` Try again in ${retryIn}s.` : ''}
            </Alert>
          ) : null}

          <div className="field">
            <label className="label" htmlFor="username">
              Username
            </label>
            <input
              id="username"
              className="input"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoFocus
              required
              disabled={busy}
            />
          </div>

          <div className="field">
            <label className="label" htmlFor="password">
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
              disabled={busy}
            />
          </div>

          <button className="btn btn-primary" type="submit" disabled={busy || throttled || !username || !password}>
            {busy ? <Spinner size={14} /> : null}
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
