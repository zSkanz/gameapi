import { useOutletContext } from 'react-router-dom';
import { Download, FileCode } from 'lucide-react';
import { downloadClient, useClientSource } from '../clientSource';
import { Luau } from '../luau';
import { Alert, CollapsibleCard, CopyButton, ErrorState, LoadingState } from '../ui';
import type { GameContext } from './GameDetail';

/**
 * The Roblox client: the source, a download, and worked examples for setup, stock and funnels. The
 * other modules' methods (serials, configs, Roblox data) are documented in the source itself.
 *
 * Every other tab that mentions GameApiClient links here rather than repeating the install steps.
 * (The Funnels tab keeps its own, fuller funnel example — keep the two in step when either changes.)
 */
export function ClientTab() {
  const { gameId } = useOutletContext<GameContext>();
  const { source, failed } = useClientSource();

  if (failed) {
    return (
      <ErrorState
        error={new Error('Could not load the client source. It is at clients/roblox/GameApiClient.lua in the repository.')}
      />
    );
  }
  if (!source) return <LoadingState label="Loading client…" />;

  const base = `${window.location.origin}/v1`;
  const setup = `--!strict
-- ServerScriptService/GameApiSetup.server.lua
local ServerScriptService = game:GetService("ServerScriptService")
local GameApi = require(ServerScriptService.GameApiClient)

-- Server-side only. In a LocalScript this key ships to every player's machine.
local api = GameApi.new({
\tbaseUrl = "${base}",
\tapiKey = "gk_xxxxxxxxxxxx.<secret>", -- API keys tab; shown once
\tgameId = "${gameId}",
})

return api`;

  const stock = `-- Limited stock. Seed it once at server start, then spend it.
api:getOrCreate("excalibur", 1000) -- creates at 1000 if missing; no-op if it exists

-- A purchase. The idempotency key is generated ONCE inside decrease() and reused on
-- every retry, so a dropped response can never sell the same unit twice.
local result = api:decrease("excalibur", 1)
print(result.stock, result.clamped) -- 999, false

api:adjust("excalibur", 50)   -- restock; caps at the record's max
api:setMax("excalibur", 500)  -- lower the ceiling (clamps stock down to it)`;

  const funnel = `-- Funnels. Queued and flushed in batches — a Roblox server gets ~500 HTTP
-- requests per MINUTE for everything, and 30 players x 6 steps is 180 events.
local Players = game:GetService("Players")

Players.PlayerAdded:Connect(function(player)
\tapi:logOnboardingFunnelStep(player, 1, "Joined")
end)

-- Wherever the player actually reaches the step:
-- api:logOnboardingFunnelStep(player, 2, "Picked Up First Item")

-- A named, repeatable funnel. The same sessionId ties one attempt together.
local function onShopOpened(player: Player)
\tlocal sessionId = game:GetService("HttpService"):GenerateGUID(false)
\tapi:logFunnelStep(player, "ShopCheckout", sessionId, 1, "Opened Shop")
\t-- ...later, the SAME sessionId:
\t-- api:logFunnelStep(player, "ShopCheckout", sessionId, 2, "Purchased")
end`;

  return (
    <div className="stack">
      <Alert kind="info">
        One module for everything this API does — stock, serials, funnels, live configs and Roblox data. Put it in{' '}
        <span className="mono">ServerScriptService</span> as a ModuleScript named{' '}
        <span className="mono">GameApiClient</span>.
      </Alert>

      <CollapsibleCard
        title="GameApiClient.lua"
        icon={<FileCode size={16} style={{ color: 'var(--accent)' }} />}
        actions={
          <>
            <span className="hint">{source.split('\n').length} lines · no dependencies</span>
            <CopyButton value={source} label="Copy" />
            <button type="button" className="btn btn-sm" onClick={() => downloadClient(source)}>
              <Download size={13} />
              Download
            </button>
          </>
        }
      >
        <Luau code={source} />
      </CollapsibleCard>

      <Example
        title="1. Set it up"
        note="Do this once, in a server script. Everything below assumes this `api`."
        code={setup}
      />
      <Example
        title="2. Stock"
        note="Mutations carry an idempotency key generated once per logical action and reused across retries — that is what makes a dropped response safe."
        code={stock}
      />
      <Example
        title="3. Funnels"
        note="These do not send immediately. They queue, and flush at 100 events or 20 seconds, plus once more when the server shuts down."
        code={funnel}
      />
    </div>
  );
}

function Example({ title, note, code }: { title: string; note: string; code: string }) {
  return (
    <CollapsibleCard title={title} actions={<CopyButton value={code} />}>
      <div className="hint">{note}</div>
      <Luau code={code} />
    </CollapsibleCard>
  );
}
