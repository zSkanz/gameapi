import { useState, type FormEvent } from 'react';
import { useOutletContext } from 'react-router-dom';
import { Plug, Send, Trash2 } from 'lucide-react';
import {
  ROBLOX_MESSAGE_MAX,
  ROBLOX_TOPIC_MAX,
  api,
  errorMessage,
  type RobloxLink,
} from '../api';
import { useAuth } from '../auth';
import { Luau } from '../luau';
import { useAsync } from '../useAsync';
import { Alert, ConfirmModal, CopyButton, ErrorState, LoadingState, Spinner, TimeCell, useToast } from '../ui';
import type { GameContext } from './GameDetail';

/**
 * Send a message to this experience's live Roblox servers, via Open Cloud MessagingService.
 *
 * Roblox caps a topic at 80 characters and a message at 1 KiB, and each topic can only RECEIVE
 * (40 + 80 x servers) messages a minute — which is why this is a person pressing Send and not
 * something wired to stock changes.
 *
 * Docs: https://create.roblox.com/docs/cloud/guides/usage-messaging
 */
export function RobloxTab() {
  const { gameId } = useOutletContext<GameContext>();
  const { isOwner } = useAuth();
  const toast = useToast();

  const link = useAsync((signal) => api.getRoblox(gameId, signal), [gameId]);
  const [topic, setTopic] = useState('gameapi');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [disconnecting, setDisconnecting] = useState(false);

  const current = link.data?.roblox ?? null;

  async function send(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.publishToRoblox(gameId, { topic, message });
      toast.success(`Sent to "${r.topic}" — every live server subscribed to it just received it.`);
      setMessage('');
      link.reload();
    } catch (err) {
      setError(err);
      link.reload(); // the failure is recorded server-side; show it on the card too
    } finally {
      setBusy(false);
    }
  }

  if (link.loading && !link.data) return <LoadingState label="Loading Roblox connection…" />;
  if (link.error) return <ErrorState error={link.error} retry={link.reload} />;

  return (
    <div className="stack">
      {current ? (
        <>
          <div className="card">
            <div className="card-body row row-wrap">
              <div className="stack" style={{ flex: 1 }}>
                <div className="row">
                  <Plug size={15} />
                  <span className="cell-strong">Connected</span>
                  <HealthBadge r={current} />
                </div>
                <div className="mono" style={{ color: 'var(--fg-subtle)' }}>
                  universe {current.universeId}
                </div>
                <div className="hint">
                  {current.lastAttemptAt ? (
                    <>
                      Last publish <TimeCell iso={current.lastAttemptAt} />
                      {current.lastError ? ` — ${current.lastError}` : current.lastApi ? ` via Open Cloud ${current.lastApi}` : ''}
                    </>
                  ) : (
                    'Nothing published yet.'
                  )}
                </div>
              </div>
              {isOwner ? (
                <button className="btn btn-sm btn-danger" onClick={() => setDisconnecting(true)} disabled={busy}>
                  <Trash2 size={13} />
                  Disconnect
                </button>
              ) : null}
            </div>
          </div>

          <div className="card">
            <form className="card-body stack" onSubmit={send}>
              <div className="card-title">Send a message</div>
              {error ? <Alert>{errorMessage(error)}</Alert> : null}

              <div className="field">
                <label className="label" htmlFor="topic">
                  Topic
                </label>
                <input
                  id="topic"
                  className="input mono"
                  value={topic}
                  onChange={(e) => setTopic(e.target.value)}
                  maxLength={ROBLOX_TOPIC_MAX}
                  autoComplete="off"
                  spellCheck={false}
                  required
                  disabled={busy}
                />
                <span className="hint">
                  Must match the topic your game passes to <span className="mono">SubscribeAsync</span>. Max{' '}
                  {ROBLOX_TOPIC_MAX} characters.
                </span>
              </div>

              <div className="field">
                <label className="label" htmlFor="msg">
                  Message
                </label>
                <textarea
                  id="msg"
                  className="input"
                  rows={3}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  maxLength={ROBLOX_MESSAGE_MAX}
                  placeholder='{"type":"reload"}'
                  required
                  disabled={busy}
                />
                <span className="hint" style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {message.length} / {ROBLOX_MESSAGE_MAX} — Roblox caps a message at 1 KiB. Arrives as a plain string;
                  send JSON if you want structure.
                </span>
              </div>

              <div className="row">
                <button className="btn btn-primary" type="submit" disabled={busy || !topic || !message}>
                  {busy ? <Spinner size={14} /> : <Send size={14} />}
                  Send to live servers
                </button>
              </div>
            </form>
          </div>
        </>
      ) : (
        <Alert kind="warn">
          Not connected. Add the universe ID and an Open Cloud API key below to send messages to this experience.
        </Alert>
      )}

      {isOwner ? <ConnectForm gameId={gameId} connected={current !== null} onDone={() => link.reload()} /> : null}

      <LuauExample topic={topic} />

      {disconnecting ? (
        <ConfirmModal
          title="Disconnect from Roblox?"
          verb="Disconnect"
          busy={busy}
          onClose={() => setDisconnecting(false)}
          onConfirm={() => {
            setBusy(true);
            void api
              .removeRoblox(gameId)
              .then(() => {
                toast.success('Disconnected. Your game is untouched.');
                setDisconnecting(false);
                link.reload();
              })
              .catch((err: unknown) => toast.error(err))
              .finally(() => setBusy(false));
          }}
        >
          <p>
            The panel stops being able to message this experience. Nothing in the game changes, and the stock and
            serial keys are untouched — you are only removing the API key stored here.
          </p>
        </ConfirmModal>
      ) : null}
    </div>
  );
}

function ConnectForm({ gameId, connected, onDone }: { gameId: string; connected: boolean; onDone: () => void }) {
  const toast = useToast();
  const [universeId, setUniverseId] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.setRoblox(gameId, { universeId, apiKey });
      setApiKey(''); // the key is stored; do not leave it sitting in a form field
      toast.success('Connected. Send a message to check it.');
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <form className="card-body stack" onSubmit={submit}>
        <div className="card-title">{connected ? 'Replace the connection' : 'Connect to Roblox'}</div>
        {error ? <Alert>{errorMessage(error)}</Alert> : null}

        <div className="field">
          <label className="label" htmlFor="universe">
            Universe ID
          </label>
          <input
            id="universe"
            className="input mono"
            value={universeId}
            onChange={(e) => setUniverseId(e.target.value)}
            placeholder="1234567890"
            inputMode="numeric"
            autoComplete="off"
            required
            disabled={busy}
          />
          <span className="hint">
            Creator Dashboard → hover the game's thumbnail → <strong>⋯</strong> → <strong>Copy Universe ID</strong>.
            This is the universe ID, not the place ID — the place ID fails with a confusing 404.
          </span>
        </div>

        <div className="field">
          <label className="label" htmlFor="ockey">
            Open Cloud API key
          </label>
          <input
            id="ockey"
            className="input mono"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            autoComplete="off"
            required
            disabled={busy}
          />
          <span className="hint">
            Creator Dashboard → API Keys → Create → add <span className="mono">messaging-service</span>, pick this
            experience, and grant <span className="mono">universe-messaging-service:publish</span>. Stored write-only —
            you will never see it here again.
          </span>
        </div>

        <div className="row">
          <button className="btn btn-primary" type="submit" disabled={busy || !universeId || !apiKey}>
            {busy ? <Spinner size={14} /> : null}
            {connected ? 'Replace connection' : 'Connect'}
          </button>
        </div>
      </form>
    </div>
  );
}

/** The other half of the feature: publishing is useless until the game is listening. */
function LuauExample({ topic }: { topic: string }) {
  const safeTopic = topic || 'gameapi';
  const code = `-- ServerScriptService/GameApiMessages.server.lua
local MessagingService = game:GetService("MessagingService")

local TOPIC = "${safeTopic}"

-- SubscribeAsync yields and can throw (Roblox rate-limits subscriptions per server),
-- so it is wrapped and retried rather than left to kill the script on a bad minute.
local function subscribe()
\tlocal ok, connection = pcall(function()
\t\treturn MessagingService:SubscribeAsync(TOPIC, function(message)
\t\t\t-- message.Data is exactly the string the panel sent (max 1 KiB).
\t\t\t-- message.Sent is the unix timestamp Roblox stamped on it.
\t\t\tprint("[GameApi]", message.Data)

\t\t\t-- If you send JSON from the panel, decode it here:
\t\t\t-- local HttpService = game:GetService("HttpService")
\t\t\t-- local okDecode, payload = pcall(HttpService.JSONDecode, HttpService, message.Data)
\t\t\t-- if okDecode and payload.type == "reload" then ... end
\t\tend)
\tend)

\tif not ok then
\t\twarn("[GameApi] subscribe failed, retrying in 5s:", connection)
\t\ttask.wait(5)
\t\treturn subscribe()
\tend
\treturn connection
end

subscribe()`;

  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title">Listen for it in your game</span>
        <div className="spacer" />
        <CopyButton value={code} label="Copy script" />
      </div>
      <div className="card-body stack">
        <div className="hint">
          A server script — <span className="mono">SubscribeAsync</span> is server-side only. Every live server running
          this receives what you send above, within a second or so.
        </div>
        <Luau code={code} />
        <div className="hint">
          Roblox limits a topic to <strong>{40} + 80 × (number of servers)</strong> received messages per minute, so
          this is for announcements and nudges — not a data feed.
        </div>
      </div>
    </div>
  );
}

function HealthBadge({ r }: { r: RobloxLink }) {
  if (!r.lastAttemptAt) return <span className="badge badge-muted">untested</span>;
  if (r.lastError) return <span className="badge badge-danger">failing</span>;
  return <span className="badge badge-ok">delivering</span>;
}
