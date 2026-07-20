import { useState } from 'react';
import { Link, useNavigate, useOutletContext } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { api } from '../api';
import { useAsync } from '../useAsync';
import { EmptyState, ErrorState, LoadingState, TimeCell, num } from '../ui';
import type { GameContext } from './GameDetail';

export function FunnelTab() {
  const { gameId } = useOutletContext<GameContext>();
  const navigate = useNavigate();
  const [includeDeleted, setIncludeDeleted] = useState(false);

  const funnels = useAsync((signal) => api.listFunnels(gameId, { includeDeleted }, signal), [gameId, includeDeleted]);

  return (
    <div className="stack">
      <div className="row row-wrap">
        <label className="check">
          <input type="checkbox" checked={includeDeleted} onChange={(e) => setIncludeDeleted(e.target.checked)} />
          Show deleted
        </label>
      </div>

      <div className="card">
        {funnels.loading && !funnels.data ? (
          <LoadingState label="Loading funnels…" />
        ) : funnels.error ? (
          <ErrorState error={funnels.error} retry={funnels.reload} />
        ) : !funnels.data || funnels.data.items.length === 0 ? (
          <EmptyState
            title="No funnels yet"
            msg="Funnels are not created here — the first time the game logs a step, the funnel and its step names appear on this list."
          />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Funnel</th>
                  <th>Kind</th>
                  <th className="num">Steps</th>
                  <th>Last event</th>
                  <th>State</th>
                  <th className="actions" />
                </tr>
              </thead>
              <tbody>
                {funnels.data.items.map((row) => (
                  <tr
                    key={row.funnelName}
                    className={row.deletedAt ? 'row-deleted' : undefined}
                    style={{ cursor: 'pointer' }}
                    onClick={() => navigate(encodeURIComponent(row.funnelName))}
                  >
                    <td>
                      {/* A real link, not just the row handler: middle-click, ctrl-click and
                          keyboard tabbing all have to reach the dashboard too. */}
                      <Link to={encodeURIComponent(row.funnelName)} className="cell-strong">
                        {row.displayName || row.funnelName}
                      </Link>
                      {row.displayName ? <div className="mono" style={{ color: 'var(--fg-subtle)' }}>{row.funnelName}</div> : null}
                    </td>
                    <td>
                      <span className={`badge badge-${row.kind === 'onboarding' ? 'owner' : 'admin'}`}>{row.kind}</span>
                    </td>
                    <td className="num">{num(row.stepCount)}</td>
                    <td>
                      <TimeCell iso={row.lastEventAt} />
                    </td>
                    <td>
                      {row.deletedAt ? (
                        <span className="badge badge-danger">deleted</span>
                      ) : row.lastEventAt ? (
                        <span className="badge badge-ok">live</span>
                      ) : (
                        <span className="badge badge-muted">idle</span>
                      )}
                    </td>
                    <td className="actions">
                      <ChevronRight size={14} style={{ color: 'var(--fg-subtle)', verticalAlign: 'middle' }} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
