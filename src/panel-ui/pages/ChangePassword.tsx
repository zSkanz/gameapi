import { useState, type FormEvent } from 'react';
import { KeyRound } from 'lucide-react';
import { api, errorMessage } from '../api';
import { useAuth } from '../auth';
import { Alert, Spinner, useToast } from '../ui';

/** Mirrors ChangePasswordBody in panel.schemas.ts. Client-side is a courtesy; the server is
 *  the authority, and its VALIDATION_ERROR still surfaces below. */
const MIN_LENGTH = 12;

export function PasswordChangeForm({ onDone }: { onDone?: () => void }) {
  const { setSession } = useAuth();
  const toast = useToast();
  const [currentPassword, setCurrent] = useState('');
  const [newPassword, setNew] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const mismatch = confirm.length > 0 && newPassword !== confirm;
  const tooShort = newPassword.length > 0 && newPassword.length < MIN_LENGTH;
  const sameAsOld = newPassword.length > 0 && newPassword === currentPassword;
  const valid = currentPassword && newPassword.length >= MIN_LENGTH && newPassword === confirm && !sameAsOld;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // The server revokes every session and mints a fresh cookie, so the response is the new
      // session — take it verbatim rather than patching mustChangePassword locally.
      const s = await api.changePassword(currentPassword, newPassword);
      setSession(s);
      setCurrent('');
      setNew('');
      setConfirm('');
      toast.success('Password changed. Other sessions were signed out.');
      onDone?.();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="stack" onSubmit={submit} style={{ gap: 'var(--sp-3)' }}>
      {error ? <Alert>{errorMessage(error)}</Alert> : null}

      <div className="field">
        <label className="label" htmlFor="cur">
          Current password
        </label>
        <input
          id="cur"
          className="input"
          type="password"
          autoComplete="current-password"
          value={currentPassword}
          onChange={(e) => setCurrent(e.target.value)}
          disabled={busy}
          required
        />
      </div>

      <div className="field">
        <label className="label" htmlFor="new">
          New password
        </label>
        <input
          id="new"
          className="input"
          type="password"
          autoComplete="new-password"
          value={newPassword}
          onChange={(e) => setNew(e.target.value)}
          disabled={busy}
          required
        />
        <span className="hint">
          {tooShort
            ? `At least ${MIN_LENGTH} characters (${newPassword.length}/${MIN_LENGTH}).`
            : sameAsOld
              ? 'Must be different from your current password.'
              : `At least ${MIN_LENGTH} characters.`}
        </span>
      </div>

      <div className="field">
        <label className="label" htmlFor="confirm">
          Confirm new password
        </label>
        <input
          id="confirm"
          className="input"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          disabled={busy}
          required
        />
        {mismatch ? <span className="hint" style={{ color: 'var(--danger)' }}>Passwords do not match.</span> : null}
      </div>

      <button className="btn btn-primary" type="submit" disabled={busy || !valid}>
        {busy ? <Spinner size={14} /> : null}
        {busy ? 'Saving…' : 'Change password'}
      </button>
    </form>
  );
}

/**
 * The forced variant: full screen, no shell, no navigation. Rendered by RequireAuth in place
 * of the whole app while mustChangePassword is set, because the server refuses every route
 * except /auth/{me,logout,password} until it clears — a shell around this would be links to
 * nothing but 403s.
 */
export function ForcedPasswordChange() {
  const { session, signOut } = useAuth();

  return (
    <div className="login-shell">
      <div className="login-card">
        <div className="login-brand">
          <span className="brand-mark" aria-hidden>
            <KeyRound size={20} />
          </span>
          <div>
            <div className="login-title">Set a new password</div>
            <div className="page-sub">
              Signed in as <strong>{session?.username}</strong>. Your password was issued by an owner and must be
              replaced before you can continue.
            </div>
          </div>
        </div>

        <div className="login-form">
          <PasswordChangeForm />
          <button
            className="btn btn-ghost btn-sm"
            type="button"
            onClick={() => {
              void signOut();
            }}
          >
            Sign out instead
          </button>
        </div>
      </div>
    </div>
  );
}
