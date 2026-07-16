import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, isApiError, setSessionHandlers, type Session } from './api';

interface AuthValue {
  session: Session | null;
  loading: boolean;
  /** Owner-only UI is hidden, never trusted — the server enforces this independently. */
  isOwner: boolean;
  setSession: (s: Session | null) => void;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const ac = new AbortController();

    // Registered BEFORE the first request so the very first /auth/me cannot outrun the
    // handlers it might need.
    setSessionHandlers({
      // Just drop the session. The redirect itself belongs to RequireAuth, which has
      // react-router's location — window.location.pathname already carries the /panel
      // basename and would double-apply it into ?next=.
      sessionInvalid: () => setSession(null),
      passwordChangeRequired: () => setSession((s) => (s && !s.mustChangePassword ? { ...s, mustChangePassword: true } : s)),
    });

    api
      .me(ac.signal)
      .then((s) => setSession(s))
      .catch((err) => {
        // A cold load with no cookie is the normal path to the login screen, not an error.
        if (!isApiError(err, 'PANEL_SESSION_INVALID') && !ac.signal.aborted) {
          // Anything else (503, network) still lands on login, which surfaces it on submit.
          setSession(null);
        }
      })
      .finally(() => {
        if (!ac.signal.aborted) setLoading(false);
      });

    return () => ac.abort();
  }, []);

  const signOut = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      // Local state clears regardless: if the server call failed the cookie may still be
      // live, but leaving the UI signed-in is the worse of the two failures.
      setSession(null);
    }
  }, []);

  const value = useMemo<AuthValue>(
    () => ({ session, loading, isOwner: session?.role === 'owner', setSession, signOut }),
    [session, loading, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
