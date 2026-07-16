import { useState, type FormEvent } from 'react';
import { KeyRound, Plus, ShieldCheck, UserMinus, UserCheck } from 'lucide-react';
import { api, errorMessage, type Role, type User } from '../api';
import { useAuth } from '../auth';
import { useAsync } from '../useAsync';
import {
  Alert,
  ConfirmModal,
  EmptyState,
  ErrorState,
  LoadingState,
  Modal,
  RoleBadge,
  SecretModal,
  Spinner,
  TimeCell,
  useToast,
} from '../ui';

export function Accounts() {
  const { session } = useAuth();
  const toast = useToast();

  const [creating, setCreating] = useState(false);
  const [resetting, setResetting] = useState<User | null>(null);
  /** Outlives the dialog that produced it — see KeysTab for the same shape. */
  const [secret, setSecret] = useState<{ username: string; password: string } | null>(null);

  const users = useAsync((signal) => api.listUsers(signal), []);

  async function patch(user: User, body: { role?: Role; disabled?: boolean }) {
    try {
      await api.updateUser(user.userId, body);
      toast.success(`Updated ${user.username}.`);
      users.reload();
    } catch (err) {
      toast.error(err);
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Accounts</h1>
          <div className="page-sub">Who can sign in to this panel.</div>
        </div>
        <button className="btn btn-primary" onClick={() => setCreating(true)}>
          <Plus size={14} />
          New account
        </button>
      </div>

      <div className="card">
        {users.loading ? (
          <LoadingState label="Loading accounts…" />
        ) : users.error ? (
          <ErrorState error={users.error} retry={users.reload} />
        ) : !users.data || users.data.items.length === 0 ? (
          <EmptyState title="No accounts" msg="That should not be possible — you are signed in." />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Username</th>
                  <th>Role</th>
                  <th>State</th>
                  <th>Created</th>
                  <th>Last login</th>
                  <th className="actions">Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.data.items.map((u) => {
                  const isSelf = u.userId === session?.userId;
                  return (
                    <tr key={u.userId} className={u.disabledAt ? 'row-deleted' : undefined}>
                      <td className="cell-strong">
                        {u.username}
                        {isSelf ? (
                          <span className="badge badge-muted" style={{ marginLeft: 6 }}>
                            you
                          </span>
                        ) : null}
                        <div className="mono" style={{ color: 'var(--fg-subtle)', fontWeight: 400 }}>
                          {u.userId}
                        </div>
                      </td>
                      <td>
                        <RoleBadge role={u.role} />
                      </td>
                      <td>
                        {u.disabledAt ? (
                          <span className="badge badge-danger">disabled</span>
                        ) : u.mustChangePassword ? (
                          <span className="badge badge-warn">must change password</span>
                        ) : (
                          <span className="badge badge-ok">active</span>
                        )}
                      </td>
                      <td>
                        <TimeCell iso={u.createdAt} />
                      </td>
                      <td>
                        {u.lastLoginAt ? <TimeCell iso={u.lastLoginAt} /> : <span className="badge badge-muted">never</span>}
                      </td>
                      <td className="actions">
                        <div className="row" style={{ justifyContent: 'flex-end' }}>
                          <button className="btn btn-sm" onClick={() => setResetting(u)} title="Generate a new password">
                            <KeyRound size={13} />
                            Reset
                          </button>
                          {/* Self-service guards. The server has its own last-owner rule; these
                              just stop the obvious foot-guns from being one click away. */}
                          <button
                            className="btn btn-sm"
                            disabled={isSelf}
                            title={isSelf ? 'You cannot change your own role' : 'Change role'}
                            onClick={() => void patch(u, { role: u.role === 'owner' ? 'admin' : 'owner' })}
                          >
                            <ShieldCheck size={13} />
                            {u.role === 'owner' ? 'Make admin' : 'Make owner'}
                          </button>
                          <button
                            className="btn btn-sm"
                            disabled={isSelf}
                            title={isSelf ? 'You cannot disable yourself' : u.disabledAt ? 'Enable' : 'Disable'}
                            style={u.disabledAt ? undefined : { color: 'var(--danger)' }}
                            onClick={() => void patch(u, { disabled: !u.disabledAt })}
                          >
                            {u.disabledAt ? <UserCheck size={13} /> : <UserMinus size={13} />}
                            {u.disabledAt ? 'Enable' : 'Disable'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {creating ? (
        <CreateUserDialog
          onClose={() => setCreating(false)}
          onCreated={(username, password) => {
            setCreating(false);
            setSecret({ username, password });
            users.reload();
          }}
        />
      ) : null}

      {resetting ? (
        <ResetPasswordDialog
          user={resetting}
          onClose={() => setResetting(null)}
          onDone={(password) => {
            const username = resetting.username;
            setResetting(null);
            setSecret({ username, password });
            users.reload();
          }}
        />
      ) : null}

      {secret ? (
        <SecretModal
          title="Password generated"
          label={`Password for ${secret.username}`}
          secret={secret.password}
          note="Hand this to them over a channel you trust. They will be forced to change it at first sign-in."
          onClose={() => setSecret(null)}
        />
      ) : null}
    </div>
  );
}

function CreateUserDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (username: string, password: string) => void;
}) {
  const [username, setUsername] = useState('');
  const [role, setRole] = useState<Role>('admin');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.createUser(username, role);
      onCreated(res.user.username, res.password);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="New account"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-primary" type="submit" form="create-user" disabled={busy || !username}>
            {busy ? <Spinner size={14} /> : null}
            Create account
          </button>
        </>
      }
    >
      <form className="dialog-body" id="create-user" onSubmit={submit}>
        {error ? <Alert>{errorMessage(error)}</Alert> : null}

        <div className="field">
          <label className="label" htmlFor="u">
            Username
          </label>
          <input
            id="u"
            className="input"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            autoFocus
            required
            disabled={busy}
          />
          <span className="hint">3–64 characters: letters, numbers and _ . - only.</span>
        </div>

        <div className="field">
          <label className="label" htmlFor="r">
            Role
          </label>
          <select id="r" className="select" value={role} onChange={(e) => setRole(e.target.value as Role)} disabled={busy}>
            <option value="admin">admin — manage stock, serials and keys</option>
            <option value="owner">owner — everything, plus accounts and purge</option>
          </select>
        </div>

        <Alert kind="info">A password is generated and shown once on the next screen.</Alert>
      </form>
    </Modal>
  );
}

function ResetPasswordDialog({
  user,
  onClose,
  onDone,
}: {
  user: User;
  onClose: () => void;
  onDone: (password: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const res = await api.resetUserPassword(user.userId);
      onDone(res.password);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <ConfirmModal
      title={`Reset password for ${user.username}?`}
      verb="Generate new password"
      danger={false}
      busy={busy}
      onConfirm={() => void confirm()}
      onClose={onClose}
    >
      {error ? <Alert>{errorMessage(error)}</Alert> : null}
      <p>
        Their current password stops working immediately and every session they have is signed out. The new password is
        shown once, here.
      </p>
    </ConfirmModal>
  );
}
