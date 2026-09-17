import { ExternalLink, RefreshCw } from 'lucide-react';
import { api, type RobloxOverview } from '../api';
import { useAsync } from '../useAsync';
import { Alert, CollapsibleCard, ErrorState, LoadingState, Spinner, TimeCell, num } from '../ui';

/** 44749017960 -> "44.7B"; the exact figure is one hover away. */
const compact = (n: number): string =>
  new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n);

/**
 * The linked experience at a glance: live stats, then its badges and game passes.
 *
 * Served from the same Redis cache as the public /v1/games/:gameId/roblox routes, so a Refresh
 * inside a minute returns the same numbers rather than spending Roblox budget. Each section fails
 * on its own — a Roblox hiccup on game passes does not blank the stats above it.
 */
export function RobloxOverviewSection({ gameId }: { gameId: string }) {
  const ov = useAsync((signal) => api.getRobloxOverview(gameId, signal), [gameId]);

  if (ov.loading && !ov.data) {
    return (
      <div className="card">
        <LoadingState label="Loading from Roblox…" />
      </div>
    );
  }
  if (ov.error) {
    return (
      <div className="card">
        <ErrorState error={ov.error} retry={ov.reload} />
      </div>
    );
  }
  const d = ov.data as RobloxOverview;
  const u = d.universe;
  // Older than two minutes means Roblox failed and the server fell back to its last copy.
  const stale = u !== null && Date.now() - Date.parse(u.fetchedAt) > 120_000;

  return (
    <>
      {d.errors.universe ? <Alert kind="warn">Stats: {d.errors.universe}</Alert> : null}
      {u === null && !d.errors.universe ? (
        <Alert kind="warn">
          Roblox has no experience with universe ID <span className="mono">{d.universeId}</span>. Check that it is the
          universe ID and not the place ID.
        </Alert>
      ) : null}

      {u ? (
        <>
          <div className="card">
            <div className="card-body roblox-hero">
              {u.iconUrl ? <img className="roblox-icon" src={u.iconUrl} alt="" referrerPolicy="no-referrer" /> : null}
              <div className="stack" style={{ gap: 4, minWidth: 0, flex: 1 }}>
                <div className="row row-wrap">
                  <a className="roblox-name" href={u.url} target="_blank" rel="noreferrer">
                    {u.name}
                    <ExternalLink size={13} />
                  </a>
                  {u.genre ? <span className="badge badge-muted">{u.genre}</span> : null}
                </div>
                <div className="hint">
                  by {u.creator.name} · universe <span className="mono">{u.universeId}</span> · updated{' '}
                  <TimeCell iso={u.updatedAt} />
                </div>
                {stale ? (
                  <div className="hint" style={{ color: 'var(--warn)' }}>
                    Roblox is not answering — showing data from <TimeCell iso={u.fetchedAt} />.
                  </div>
                ) : null}
              </div>
              <button type="button" className="btn btn-sm btn-ghost" onClick={ov.reload} disabled={ov.loading}>
                {ov.loading ? <Spinner size={13} /> : <RefreshCw size={13} />}
                Refresh
              </button>
            </div>
          </div>

          <div className="stats">
            <Stat label="Playing now" value={u.playing} />
            <Stat label="Visits" value={u.visits} />
            <Stat label="Favorites" value={u.favorites} />
            <div className="stat">
              <div className="stat-label">Likes</div>
              <div className="stat-value">{u.likeRatio === null ? '—' : `${(u.likeRatio * 100).toFixed(1)}%`}</div>
              <div className="hint" title={`${num(u.upVotes)} up · ${num(u.downVotes)} down`}>
                {compact(u.upVotes)} up · {compact(u.downVotes)} down
              </div>
            </div>
          </div>
        </>
      ) : null}

      {d.errors.badges ? <Alert kind="warn">Badges: {d.errors.badges}</Alert> : null}
      {d.badges ? (
        <CollapsibleCard title={`Badges (${d.badges.items.length}${d.badges.nextCursor ? '+' : ''})`}>
          {d.badges.items.length === 0 ? (
            <div className="hint">This experience has no badges.</div>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Badge</th>
                    <th>Status</th>
                    <th className="num">Awarded</th>
                    <th className="num">Past day</th>
                    <th>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {d.badges.items.map((b) => (
                    <tr key={b.badgeId}>
                      <td>
                        <Named iconUrl={b.iconUrl} name={b.name} sub={b.description} />
                      </td>
                      <td>
                        <span className={`badge badge-${b.enabled ? 'ok' : 'muted'}`}>{b.enabled ? 'enabled' : 'disabled'}</span>
                      </td>
                      <td className="num">{num(b.awardedCount)}</td>
                      <td className="num">{num(b.pastDayAwardedCount)}</td>
                      <td>
                        <TimeCell iso={b.createdAt} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CollapsibleCard>
      ) : null}

      {d.errors.gamePasses ? <Alert kind="warn">Game passes: {d.errors.gamePasses}</Alert> : null}
      {d.gamePasses ? (
        <CollapsibleCard title={`Game passes (${d.gamePasses.items.length}${d.gamePasses.nextCursor ? '+' : ''})`}>
          {d.gamePasses.items.length === 0 ? (
            <div className="hint">This experience has no game passes.</div>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Game pass</th>
                    <th className="num">Price</th>
                    <th className="num">ID</th>
                    <th>Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {d.gamePasses.items.map((p) => (
                    <tr key={p.gamePassId}>
                      <td>
                        <Named iconUrl={p.iconUrl} name={p.name} sub={p.description} />
                      </td>
                      <td className="num">
                        {p.price === null ? <span className="badge badge-muted">not for sale</span> : `R$ ${num(p.price)}`}
                      </td>
                      <td className="num mono">{p.gamePassId}</td>
                      <td>
                        <TimeCell iso={p.updatedAt} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CollapsibleCard>
      ) : null}
    </>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value" title={num(value)}>
        {value >= 100_000 ? compact(value) : num(value)}
      </div>
    </div>
  );
}

function Named({ iconUrl, name, sub }: { iconUrl: string | null; name: string; sub: string }) {
  return (
    <div className="row" style={{ gap: 'var(--sp-3)', minWidth: 0 }}>
      {iconUrl ? (
        <img className="roblox-thumb" src={iconUrl} alt="" referrerPolicy="no-referrer" loading="lazy" />
      ) : (
        <span className="roblox-thumb" />
      )}
      <div style={{ minWidth: 0 }}>
        <div className="cell-strong">{name}</div>
        {sub ? <div className="hint roblox-sub">{sub}</div> : null}
      </div>
    </div>
  );
}
