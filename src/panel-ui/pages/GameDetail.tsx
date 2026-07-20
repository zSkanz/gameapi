import { Link, NavLink, Outlet, useParams } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';
import { api } from '../api';
import { useAsync } from '../useAsync';
import { EmptyState, ErrorState, LoadingState, TimeCell, num } from '../ui';

export function GameDetail() {
  const { gameId = '' } = useParams();

  const game = useAsync((signal) => api.getGame(gameId, signal), [gameId]);

  // `&& !game.data` is load-bearing, not a nicety. Every tab calls reloadGame() after a
  // mutation, which flips loading back to true — and swapping the whole page for a spinner
  // unmounts the <Outlet/>, taking the active tab's state with it. KeysTab holds the one and
  // only copy of a newly minted API key in that state, so a bare `if (game.loading)` destroyed
  // the secret before its modal could ever render. Keep showing the data we already have.
  if (game.loading && !game.data) return <div className="page"><LoadingState /></div>;
  if (game.error) return <div className="page"><ErrorState error={game.error} retry={game.reload} /></div>;
  if (!game.data) {
    return (
      <div className="page">
        <EmptyState
          title="No such game"
          msg={`Nothing is registered under "${gameId}".`}
          action={
            <Link className="btn btn-sm" to="/games">
              Back to games
            </Link>
          }
        />
      </div>
    );
  }

  const g = game.data;

  return (
    <div className="page">
      <div>
        <Link to="/games" className="btn btn-ghost btn-sm" style={{ marginLeft: 'calc(var(--sp-2) * -1)' }}>
          <ChevronLeft size={14} />
          Games
        </Link>
      </div>

      <div className="page-head">
        <div>
          <h1 className="page-title">{g.name}</h1>
          <div className="row" style={{ marginTop: 4 }}>
            <span className="mono" style={{ color: 'var(--fg-subtle)' }}>
              {g.gameId}
            </span>
            <span className={`badge badge-${g.status === 'active' ? 'ok' : 'muted'}`}>{g.status}</span>
          </div>
        </div>
      </div>

      <div className="stats">
        <div className="stat">
          <div className="stat-label">Stock keys</div>
          <div className="stat-value">{num(g.stockKeys)}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Serials</div>
          <div className="stat-value">{num(g.serialKeys)}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Active keys</div>
          <div className="stat-value">
            {num(g.activeKeys)}
            <span style={{ fontSize: 'var(--text-sm)', color: 'var(--fg-subtle)', fontWeight: 500 }}>
              {' '}
              / {num(g.maxKeys)}
            </span>
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">Created</div>
          <div className="stat-value" style={{ fontSize: 'var(--text-lg)' }}>
            <TimeCell iso={g.createdAt} />
          </div>
        </div>
      </div>

      <nav className="tabs">
        <Tab to="stock" label="Stock" count={g.stockKeys} />
        <Tab to="serial" label="Serials" count={g.serialKeys} />
        <Tab to="keys" label="API keys" count={g.activeKeys} />
        <Tab to="funnels" label="Funnels" />
        <Tab to="webhook" label="Discord log" />
        <Tab to="roblox" label="Roblox" />
        <Tab to="client" label="Client" />
      </nav>

      {/* Tabs reload the header when they mutate counts (create/delete). */}
      <Outlet context={{ gameId, reloadGame: game.reload }} />
    </div>
  );
}

function Tab({ to, label, count }: { to: string; label: string; count?: number }) {
  return (
    <NavLink to={to} className={({ isActive }) => `tab${isActive ? ' active' : ''}`}>
      {label}
      {count === undefined ? null : <span className="tab-count">{count.toLocaleString()}</span>}
    </NavLink>
  );
}

export interface GameContext {
  gameId: string;
  reloadGame: () => void;
}
