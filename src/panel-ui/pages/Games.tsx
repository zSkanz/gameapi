import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Plus, RotateCcw, Trash2 } from 'lucide-react';
import { api, errorMessage, type Game } from '../api';
import { useAuth } from '../auth';
import { useAsync } from '../useAsync';
import { useDebounced } from '../useDebounced';
import {
  Alert,
  ConfirmModal,
  EmptyState,
  ErrorState,
  LoadingState,
  Modal,
  Pager,
  SearchInput,
  Spinner,
  TimeCell,
  num,
  useToast,
} from '../ui';

const LIMIT = 50;

export function Games() {
  const { isOwner } = useAuth();
  const [q, setQ] = useState('');
  const [offset, setOffset] = useState(0);
  const [creating, setCreating] = useState(false);
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [confirm, setConfirm] = useState<{ game: Game; action: 'delete' | 'restore' } | null>(null);
  const search = useDebounced(q, 250);

  const games = useAsync(
    (signal) => api.listGames({ q: search, includeDeleted, limit: LIMIT, offset }, signal),
    [search, includeDeleted, offset],
  );

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Games</h1>
          <div className="page-sub">Every registered tenant and what it holds.</div>
        </div>
        <div className="row">
          <SearchInput value={q} onChange={(v) => { setQ(v); setOffset(0); }} placeholder="Search games…" />
          <label className="check">
            <input
              type="checkbox"
              checked={includeDeleted}
              onChange={(e) => { setIncludeDeleted(e.target.checked); setOffset(0); }}
            />
            Show deleted
          </label>
          {/* Owner-only. The server enforces panel:owner on POST /games regardless. */}
          {isOwner ? (
            <button className="btn btn-primary" onClick={() => setCreating(true)}>
              <Plus size={14} />
              New game
            </button>
          ) : null}
        </div>
      </div>

      <div className="card">
        {games.loading ? (
          <LoadingState label="Loading games…" />
        ) : games.error ? (
          <ErrorState error={games.error} retry={games.reload} />
        ) : !games.data || games.data.items.length === 0 ? (
          <EmptyState
            title={search ? 'No games match that search' : 'No games yet'}
            msg={
              search
                ? 'Try a different name or id.'
                : isOwner
                  ? 'Create a game to mint its first API key.'
                  : 'An owner needs to create the first game.'
            }
            action={
              isOwner && !search ? (
                <button className="btn btn-sm" onClick={() => setCreating(true)}>
                  <Plus size={13} />
                  New game
                </button>
              ) : null
            }
          />
        ) : (
          <>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Game</th>
                    <th>Status</th>
                    <th className="num">Stock keys</th>
                    <th className="num">Serials</th>
                    <th className="num">Active keys</th>
                    <th className="num">Key limit</th>
                    <th>Created</th>
                    {isOwner ? <th className="actions">Actions</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {games.data.items.map((g) => (
                    <GameRow key={g.gameId} game={g} isOwner={isOwner} onAction={(action) => setConfirm({ game: g, action })} />
                  ))}
                </tbody>
              </table>
            </div>
            <Pager total={games.data.total} limit={LIMIT} offset={offset} onOffset={setOffset} />
          </>
        )}
      </div>

      {creating ? (
        <CreateGameDialog
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            games.reload();
          }}
        />
      ) : null}

      {confirm ? (
        <GameActionDialog
          game={confirm.game}
          action={confirm.action}
          onClose={() => setConfirm(null)}
          onDone={() => {
            setConfirm(null);
            games.reload();
          }}
        />
      ) : null}
    </div>
  );
}

function GameRow({
  game,
  isOwner,
  onAction,
}: {
  game: Game;
  isOwner: boolean;
  onAction: (action: 'delete' | 'restore') => void;
}) {
  const deleted = game.deletedAt !== null;
  return (
    <tr className={deleted ? 'row-deleted' : undefined}>
      <td>
        <Link to={`/games/${encodeURIComponent(game.gameId)}`} className="cell-strong">
          {game.name}
        </Link>
        <div className="mono" style={{ color: 'var(--fg-subtle)' }}>
          {game.gameId}
        </div>
      </td>
      <td>
        {deleted ? (
          <span className="badge badge-danger">deleted</span>
        ) : (
          <span className={`badge badge-${game.status === 'active' ? 'ok' : 'muted'}`}>{game.status}</span>
        )}
      </td>
      <td className="num">{num(game.stockKeys)}</td>
      <td className="num">{num(game.serialKeys)}</td>
      <td className="num">{num(game.activeKeys)}</td>
      <td className="num">{num(game.maxKeys)}</td>
      <td>
        <TimeCell iso={game.createdAt} />
      </td>
      {isOwner ? (
        <td className="actions">
          {deleted ? (
            <button className="btn btn-sm btn-icon btn-ghost" title="Restore game" onClick={() => onAction('restore')}>
              <RotateCcw size={15} />
            </button>
          ) : (
            <button className="btn btn-sm btn-icon btn-ghost" title="Delete game" onClick={() => onAction('delete')}>
              <Trash2 size={15} />
            </button>
          )}
        </td>
      ) : null}
    </tr>
  );
}

/**
 * Delete is reversible and destroys nothing — so it gets a plain confirm, not the type-the-name
 * ritual that purge uses. What it does need to say out loud is that the game goes silent: its
 * API keys stop authenticating, and a live game would start failing.
 */
function GameActionDialog({
  game,
  action,
  onClose,
  onDone,
}: {
  game: Game;
  action: 'delete' | 'restore';
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const restoring = action === 'restore';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      if (restoring) {
        await api.restoreGame(game.gameId);
        toast.success(`${game.name} restored. Its API keys work again now.`);
      } else {
        const r = await api.deleteGame(game.gameId);
        toast.success(
          r.keysDisabled > 0
            ? `${game.name} deleted. ${r.keysDisabled} API key${r.keysDisabled === 1 ? '' : 's'} stop working within ${r.effectiveWithinSeconds}s.`
            : `${game.name} deleted.`,
        );
      }
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <ConfirmModal
      title={restoring ? `Restore ${game.name}?` : `Delete ${game.name}?`}
      verb={restoring ? 'Restore game' : 'Delete game'}
      danger={!restoring ? true : false}
      busy={busy}
      onClose={onClose}
      onConfirm={() => void run()}
    >
      {error ? <Alert>{errorMessage(error)}</Alert> : null}
      {restoring ? (
        <p>
          The game comes back exactly as it was — its stock, serials and API keys all resume. Keys start
          authenticating again right away.
        </p>
      ) : (
        <>
          <p>
            Nothing is destroyed. The game disappears from this list and its{' '}
            <strong>{num(game.activeKeys)} API key{game.activeKeys === 1 ? '' : 's'} stop authenticating</strong> within
            30 seconds — any live game server using them starts getting 401s.
          </p>
          <p style={{ color: 'var(--fg-muted)' }}>
            Its {num(game.stockKeys)} stock key{game.stockKeys === 1 ? '' : 's'} and {num(game.serialKeys)} serial
            {game.serialKeys === 1 ? '' : 's'} are kept, and you can restore it at any time.
          </p>
        </>
      )}
    </ConfirmModal>
  );
}

function CreateGameDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const toast = useToast();
  const [gameId, setGameId] = useState('');
  const [name, setName] = useState('');
  const [maxKeys, setMaxKeys] = useState(10_000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // No Idempotency-Key: POST /games is naturally idempotent server-side (ON CONFLICT DO
      // NOTHING on the primary key, then a 409), so a double-submit cannot create two games.
      await api.createGame({ gameId, name, maxKeys });
      toast.success(`Game ${gameId} created.`);
      onCreated();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="New game"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-primary" type="submit" form="create-game" disabled={busy || !gameId || !name}>
            {busy ? <Spinner size={14} /> : null}
            Create game
          </button>
        </>
      }
    >
      <form className="dialog-body" id="create-game" onSubmit={submit}>
        {error ? <Alert>{errorMessage(error)}</Alert> : null}

        <div className="field">
          <label className="label" htmlFor="gameId">
            Game ID
          </label>
          <input
            id="gameId"
            className="input mono"
            value={gameId}
            onChange={(e) => setGameId(e.target.value)}
            placeholder="sword-sim"
            autoComplete="off"
            spellCheck={false}
            autoFocus
            required
            disabled={busy}
          />
          <span className="hint">Letters, numbers and : _ . - (max 64). Permanent — this is the tenant key.</span>
        </div>

        <div className="field">
          <label className="label" htmlFor="name">
            Display name
          </label>
          <input
            id="name"
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Sword Simulator"
            required
            disabled={busy}
          />
        </div>

        <div className="field">
          <label className="label" htmlFor="maxKeys">
            API key limit
          </label>
          <input
            id="maxKeys"
            className="input input-num"
            type="number"
            min={1}
            max={1_000_000}
            value={maxKeys}
            onChange={(e) => setMaxKeys(Number(e.target.value))}
            required
            disabled={busy}
          />
          <span className="hint">How many API keys this game may hold at once.</span>
        </div>
      </form>
    </Modal>
  );
}
