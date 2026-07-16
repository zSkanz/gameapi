import { useState, type FormEvent } from 'react';
import { useOutletContext } from 'react-router-dom';
import { Ban, Plus } from 'lucide-react';
import { ALL_SCOPES, api, errorMessage, type ApiKey, type Scope } from '../api';
import { useAsync } from '../useAsync';
import {
  Alert,
  ConfirmModal,
  EmptyState,
  ErrorState,
  LoadingState,
  Modal,
  Pager,
  SecretModal,
  Spinner,
  TimeCell,
  useToast,
} from '../ui';
import type { GameContext } from './GameDetail';

const LIMIT = 50;

export function KeysTab() {
  const { gameId, reloadGame } = useOutletContext<GameContext>();

  const [includeRevoked, setIncludeRevoked] = useState(false);
  const [offset, setOffset] = useState(0);
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);
  /** Held here, not in the create dialog: the dialog unmounts on success and this must outlive it. */
  const [fullKey, setFullKey] = useState<string | null>(null);

  const keys = useAsync(
    (signal) => api.listKeys(gameId, { includeRevoked, limit: LIMIT, offset }, signal),
    [gameId, includeRevoked, offset],
  );

  function done() {
    keys.reload();
    reloadGame();
  }

  return (
    <div className="stack">
      <div className="row row-wrap">
        <label className="check">
          <input
            type="checkbox"
            checked={includeRevoked}
            onChange={(e) => { setIncludeRevoked(e.target.checked); setOffset(0); }}
          />
          Show revoked
        </label>
        <div className="spacer" />
        <button className="btn btn-primary" onClick={() => setCreating(true)}>
          <Plus size={14} />
          New API key
        </button>
      </div>

      <Alert kind="info">
        These are the keys the game pastes into <span className="mono">X-Api-Key</span>. They reach the game API only —
        never this panel.
      </Alert>

      <div className="card">
        {keys.loading ? (
          <LoadingState label="Loading keys…" />
        ) : keys.error ? (
          <ErrorState error={keys.error} retry={keys.reload} />
        ) : !keys.data || keys.data.items.length === 0 ? (
          <EmptyState title="No API keys yet" msg="Create one to let this game talk to the API." />
        ) : (
          <>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Label</th>
                    <th>Key ID</th>
                    <th>Scopes</th>
                    <th>Created</th>
                    <th>Last used</th>
                    <th>State</th>
                    <th className="actions">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {keys.data.items.map((k) => (
                    <tr key={k.keyId} className={k.revokedAt ? 'row-deleted' : undefined}>
                      <td className="cell-strong">
                        {k.label}
                        {k.createdBy ? (
                          <div className="hint" style={{ fontWeight: 400 }}>
                            by {k.createdBy}
                          </div>
                        ) : null}
                      </td>
                      <td className="mono">{k.keyId}</td>
                      <td>
                        <div className="row row-wrap" style={{ gap: 4 }}>
                          {k.scopes.map((s) => (
                            <span key={s} className="badge badge-muted">
                              {s}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td>
                        <TimeCell iso={k.createdAt} />
                      </td>
                      <td>
                        {/* An unused key is worth spotting: it is either dead config or a leak. */}
                        {k.lastUsedAt ? <TimeCell iso={k.lastUsedAt} /> : <span className="badge badge-muted">never</span>}
                      </td>
                      <td>
                        {k.revokedAt ? (
                          <span className="badge badge-danger">revoked</span>
                        ) : (
                          <span className="badge badge-ok">active</span>
                        )}
                      </td>
                      <td className="actions">
                        {k.revokedAt ? (
                          <span style={{ color: 'var(--fg-subtle)' }}>—</span>
                        ) : (
                          <button className="btn btn-sm" onClick={() => setRevoking(k)}>
                            <Ban size={13} />
                            Revoke
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager total={keys.data.total} limit={LIMIT} offset={offset} onOffset={setOffset} />
          </>
        )}
      </div>

      {creating ? (
        <CreateKeyDialog
          gameId={gameId}
          onClose={() => setCreating(false)}
          onCreated={(full) => {
            setCreating(false);
            setFullKey(full);
            done();
          }}
        />
      ) : null}

      {fullKey ? (
        <SecretModal
          title="API key created"
          label="Full API key"
          secret={fullKey}
          note={
            <>
              Paste this into the game as the <span className="mono">X-Api-Key</span> header. Only the key id is
              stored here — the secret half is hashed and cannot be shown again.
            </>
          }
          onClose={() => setFullKey(null)}
        />
      ) : null}

      {revoking ? (
        <RevokeDialog
          gameId={gameId}
          apiKey={revoking}
          onClose={() => setRevoking(null)}
          onDone={() => {
            setRevoking(null);
            done();
          }}
        />
      ) : null}
    </div>
  );
}

function CreateKeyDialog({
  gameId,
  onClose,
  onCreated,
}: {
  gameId: string;
  onClose: () => void;
  onCreated: (fullKey: string) => void;
}) {
  const [label, setLabel] = useState('');
  const [scopes, setScopes] = useState<Scope[]>([...ALL_SCOPES]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  function toggle(s: Scope) {
    setScopes((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // No Idempotency-Key in the contract for this route. A double-submit mints a second key
      // rather than corrupting anything — visible in the list, and revocable.
      const res = await api.createKey(gameId, { label, scopes });
      onCreated(res.fullKey);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="New API key"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-primary" type="submit" form="create-key" disabled={busy || !label || scopes.length === 0}>
            {busy ? <Spinner size={14} /> : null}
            Create key
          </button>
        </>
      }
    >
      <form className="dialog-body" id="create-key" onSubmit={submit}>
        {error ? <Alert>{errorMessage(error)}</Alert> : null}

        <div className="field">
          <label className="label" htmlFor="label">
            Label
          </label>
          <input
            id="label"
            className="input"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Live server"
            autoFocus
            required
            disabled={busy}
          />
          <span className="hint">How you will recognise this key in the list later.</span>
        </div>

        <div className="field">
          <span className="label">Scopes</span>
          <div className="stack" style={{ gap: 'var(--sp-1)' }}>
            {ALL_SCOPES.map((s) => (
              <label className="check" key={s}>
                <input type="checkbox" checked={scopes.includes(s)} onChange={() => toggle(s)} disabled={busy} />
                <span className="mono">{s}</span>
              </label>
            ))}
          </div>
          {scopes.length === 0 ? <Alert kind="warn">Pick at least one scope.</Alert> : null}
          <span className="hint">Grant only what the game needs — a read-only key cannot be used to drain stock.</span>
        </div>
      </form>
    </Modal>
  );
}

function RevokeDialog({
  gameId,
  apiKey,
  onClose,
  onDone,
}: {
  gameId: string;
  apiKey: ApiKey;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await api.revokeKey(gameId, apiKey.keyId);
      toast.success(`Revoked ${apiKey.label}.`);
      onDone();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <ConfirmModal title={`Revoke ${apiKey.label}?`} verb="Revoke" busy={busy} onConfirm={() => void confirm()} onClose={onClose}>
      {error ? <Alert>{errorMessage(error)}</Alert> : null}
      <p>
        Any game still presenting <span className="mono">{apiKey.keyId}</span> starts getting 401s immediately. This
        cannot be undone — issue a new key instead.
      </p>
    </ConfirmModal>
  );
}
