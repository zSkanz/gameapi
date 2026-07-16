import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { api, errorMessage, type Game } from '../api';
import { useAuth } from '../auth';
import { useAsync } from '../useAsync';
import { useDebounced } from '../useDebounced';
import {
  Alert,
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
  const search = useDebounced(q, 250);

  const games = useAsync(
    (signal) => api.listGames({ q: search, limit: LIMIT, offset }, signal),
    [search, offset],
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
                  </tr>
                </thead>
                <tbody>
                  {games.data.items.map((g) => (
                    <GameRow key={g.gameId} game={g} />
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
    </div>
  );
}

function GameRow({ game }: { game: Game }) {
  return (
    <tr>
      <td>
        <Link to={`/games/${encodeURIComponent(game.gameId)}`} className="cell-strong">
          {game.name}
        </Link>
        <div className="mono" style={{ color: 'var(--fg-subtle)' }}>
          {game.gameId}
        </div>
      </td>
      <td>
        <span className={`badge badge-${game.status === 'active' ? 'ok' : 'muted'}`}>{game.status}</span>
      </td>
      <td className="num">{num(game.stockKeys)}</td>
      <td className="num">{num(game.serialKeys)}</td>
      <td className="num">{num(game.activeKeys)}</td>
      <td className="num">{num(game.maxKeys)}</td>
      <td>
        <TimeCell iso={game.createdAt} />
      </td>
    </tr>
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
