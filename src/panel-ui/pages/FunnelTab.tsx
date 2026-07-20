import { useState } from 'react';
import { Link, useNavigate, useOutletContext } from 'react-router-dom';
import { BookOpen, ChevronDown, ChevronRight } from 'lucide-react';
import { api } from '../api';
import { Luau } from '../luau';
import { useAsync } from '../useAsync';
import { Alert, CopyButton, EmptyState, ErrorState, LoadingState, TimeCell, num } from '../ui';
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

      <SetupGuide gameId={gameId} hasFunnels={(funnels.data?.items.length ?? 0) > 0} />
    </div>
  );
}

/**
 * How to wire a funnel up, with a script to paste.
 *
 * Open by default until the game has actually logged something — at that point it is reference
 * material rather than instructions, so it collapses out of the way instead of pushing the data
 * down the page forever.
 */
function SetupGuide({ gameId, hasFunnels }: { gameId: string; hasFunnels: boolean }) {
  const [open, setOpen] = useState(!hasFunnels);

  const code = `--!strict
-- ServerScriptService/Onboarding.server.lua
local ServerScriptService = game:GetService("ServerScriptService")
local Players = game:GetService("Players")

local GameApi = require(ServerScriptService.GameApiClient)

local api = GameApi.new({
\tbaseUrl = "${window.location.origin}/v1",
\tapiKey = "gk_xxxxxxxxxxxx.<secret>", -- API keys tab. Server-side only, never in a LocalScript.
\tgameId = "${gameId}",
})

-- The ONE onboarding funnel. Same arguments as Roblox's
-- AnalyticsService:LogOnboardingFunnelStepEvent(player, step, stepName).
-- Steps must start at 1 and go up; the names are what the dashboard shows.
Players.PlayerAdded:Connect(function(player)
\tapi:logOnboardingFunnelStep(player, 1, "Joined")
end)

-- Call these wherever the player actually reaches the step:
-- api:logOnboardingFunnelStep(player, 2, "Picked Up First Item")
-- api:logOnboardingFunnelStep(player, 3, "Opened First Crate")

-- A named, repeatable funnel. funnelSessionId separates one attempt from the next,
-- so a player opening the shop twice is two runs, not one.
local function onShopOpened(player)
\tlocal sessionId = game:GetService("HttpService"):GenerateGUID(false)
\tapi:logFunnelStep(player, "ShopCheckout", sessionId, 1, "Opened Shop")
\t-- ...later, the SAME sessionId:
\t-- api:logFunnelStep(player, "ShopCheckout", sessionId, 2, "Added To Cart")
\t-- api:logFunnelStep(player, "ShopCheckout", sessionId, 3, "Purchased")
end

-- Optional: segment the dashboard. Only these three keys exist, exactly as on Roblox.
-- api:logOnboardingFunnelStep(player, 2, "Picked Up First Item", {
-- \tCustomField01 = "Starter - Sword",
-- \tCustomField02 = "Platform - Mobile",
-- })

return onShopOpened`;

  return (
    <div className="card">
      <button
        type="button"
        className="card-head"
        onClick={() => setOpen((v) => !v)}
        style={{ width: '100%', background: 'var(--bg-inset)', border: 0, cursor: 'pointer', textAlign: 'left' }}
        aria-expanded={open}
      >
        <BookOpen size={16} style={{ color: 'var(--accent)' }} />
        <span className="card-title">How to set up a funnel</span>
        <div className="spacer" />
        {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
      </button>

      {open ? (
        <div className="card-body stack">
          <Alert kind="info">
            Funnels are not created here. The first time your game logs a step, the funnel and its step names
            appear on the list above — so setup is entirely on the Roblox side.
          </Alert>

          <ol className="steps-list">
            <li>
              <strong>Put the client in the game.</strong> Get{' '}
              <Link to="../client" className="mono">GameApiClient.lua</Link> from the{' '}
              <Link to="../client">Client</Link> tab — copy or download it there — and paste it into{' '}
              <span className="mono">ServerScriptService</span> as a ModuleScript named{' '}
              <span className="mono">GameApiClient</span>. Server-side only: in a LocalScript your API key would
              ship to every player's machine.
            </li>
            <li>
              <strong>Mint an API key</strong> on the <Link to="../keys">API keys</Link> tab with the{' '}
              <span className="mono">funnel:write</span> scope. It is shown once.
            </li>
            <li>
              <strong>Call a log function</strong> at each point you care about, using the script below. Events are
              queued and sent in batches — a Roblox server only gets ~500 HTTP requests per <em>minute</em> for
              everything it does, and a 6-step funnel across 30 players is 180 events.
            </li>
            <li>
              <strong>Come back here.</strong> The funnel appears within a flush (20s or 100 events, whichever comes
              first, plus a flush when the server shuts down).
            </li>
          </ol>

          <div className="row">
            <span className="label">Paste this into ServerScriptService</span>
            <div className="spacer" />
            <CopyButton value={code} label="Copy script" />
          </div>
          <Luau code={code} />

          <div className="hint">
            The arguments match{' '}
            <a href="https://create.roblox.com/docs/production/analytics/funnel-events" target="_blank" rel="noreferrer">
              Roblox's own AnalyticsService
            </a>{' '}
            on purpose, so the two read the same. Their limits apply here too: steps <strong>1–100</strong>,{' '}
            <strong>10</strong> named funnels per game, and only{' '}
            <span className="mono">CustomField01/02/03</span> for segmentation.
          </div>

          <Alert kind="warn">
            A step logged twice for the same player is ignored, not counted twice — so retries and reconnects are
            safe. But deleting a funnel here makes the game's events <strong>drop</strong> rather than re-create it;
            restore it to start recording again.
          </Alert>
        </div>
      ) : null}
    </div>
  );
}
