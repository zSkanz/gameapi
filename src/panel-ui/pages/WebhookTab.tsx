import { useState, type FormEvent } from 'react';
import { useOutletContext } from 'react-router-dom';
import { Bell, BellOff, Send, Trash2 } from 'lucide-react';
import { api, errorMessage, type Webhook } from '../api';
import { useAuth } from '../auth';
import { useAsync } from '../useAsync';
import { Alert, ConfirmModal, ErrorState, LoadingState, Spinner, TimeCell, useToast } from '../ui';
import type { GameContext } from './GameDetail';

/**
 * Discord logging for this game.
 *
 * Logs what PEOPLE do in the panel — not what the games do through the API. A Roblox server
 * decrementing stock thousands of times a minute is not a chat message; the ledger already has
 * it. The server decides this by looking for a panel session on the request, so it is not a
 * filter that can drift out of sync with reality.
 */
export function WebhookTab() {
  const { gameId } = useOutletContext<GameContext>();
  const { isOwner } = useAuth();
  const toast = useToast();

  const hook = useAsync((signal) => api.getWebhook(gameId, signal), [gameId]);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [removing, setRemoving] = useState(false);

  const current = hook.data?.webhook ?? null;

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.setWebhook(gameId, { url, enabled: true });
      setUrl(''); // never keep the secret in a form field after it is stored
      toast.success('Webhook saved. Send a test to check it.');
      hook.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function toggle(enabled: boolean) {
    // Toggling needs the URL, which the server will not give back — so off/on is delete/re-add.
    setBusy(true);
    try {
      if (!enabled) {
        await api.removeWebhook(gameId);
        toast.success('Logging off. Add the URL again to turn it back on.');
      }
      hook.reload();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    try {
      const r = await api.testWebhook(gameId);
      if (r.delivered) toast.success('Test message delivered — check the channel.');
      else toast.error(new Error(r.webhook?.lastError ?? 'Discord did not accept it.'));
      hook.reload();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  if (hook.loading && !hook.data) return <LoadingState label="Loading webhook…" />;
  if (hook.error) return <ErrorState error={hook.error} retry={hook.reload} />;

  return (
    <div className="stack">
      <Alert kind="info">
        Posts to Discord whenever <strong>a person</strong> changes something here — stock, serials, API keys, this
        game. Actions your games take through the API are <strong>not</strong> logged: they are the ledger's job, and
        they would flood the channel.
      </Alert>

      {current ? (
        <div className="card">
          <div className="card-body row row-wrap">
            <div className="stack" style={{ flex: 1 }}>
              <div className="row">
                {current.enabled ? <Bell size={15} /> : <BellOff size={15} />}
                <span className="cell-strong">{current.enabled ? 'Logging to Discord' : 'Logging off'}</span>
                <HealthBadge w={current} />
              </div>
              <div className="mono" style={{ color: 'var(--fg-subtle)' }}>
                {current.url}
              </div>
              <div className="hint">
                {current.lastAttemptAt ? (
                  <>
                    Last delivery <TimeCell iso={current.lastAttemptAt} />
                    {current.lastError ? ` — ${current.lastError}` : ''}
                  </>
                ) : (
                  'Nothing sent yet.'
                )}
              </div>
            </div>
            {isOwner ? (
              <div className="row">
                <button className="btn btn-sm" onClick={() => void test()} disabled={busy}>
                  {busy ? <Spinner size={13} /> : <Send size={13} />}
                  Send test
                </button>
                <button className="btn btn-sm btn-danger" onClick={() => setRemoving(true)} disabled={busy}>
                  <Trash2 size={13} />
                  Remove
                </button>
              </div>
            ) : null}
          </div>
        </div>
      ) : (
        <Alert kind="warn">No webhook yet — nothing is being logged for this game.</Alert>
      )}

      {isOwner ? (
        <div className="card">
          <form className="card-body stack" onSubmit={save}>
            {error ? <Alert>{errorMessage(error)}</Alert> : null}
            <div className="field">
              <label className="label" htmlFor="hook-url">
                {current ? 'Replace the webhook URL' : 'Discord webhook URL'}
              </label>
              <input
                id="hook-url"
                className="input mono"
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://discord.com/api/webhooks/…"
                autoComplete="off"
                spellCheck={false}
                required
                disabled={busy}
              />
              <span className="hint">
                Discord → Server settings → Integrations → Webhooks → New webhook → Copy URL. Anyone holding this URL
                can post to that channel, so it is stored write-only: you will never see it here again.
              </span>
            </div>
            <div className="row">
              <button className="btn btn-primary" type="submit" disabled={busy || !url}>
                {busy ? <Spinner size={14} /> : null}
                {current ? 'Replace webhook' : 'Save webhook'}
              </button>
            </div>
          </form>
        </div>
      ) : (
        <Alert kind="info">Only an owner can change the webhook.</Alert>
      )}

      {removing ? (
        <ConfirmModal
          title="Remove this webhook?"
          verb="Remove"
          busy={busy}
          onClose={() => setRemoving(false)}
          onConfirm={() => {
            void toggle(false).then(() => setRemoving(false));
          }}
        >
          <p>Panel actions stop being posted to Discord. Nothing else changes, and the ledger keeps recording them.</p>
        </ConfirmModal>
      ) : null}
    </div>
  );
}

/**
 * Delivery is fire-and-forget, so a broken webhook is otherwise invisible — the actions still
 * succeed and the messages just never arrive. This is the only place that says so.
 */
function HealthBadge({ w }: { w: Webhook }) {
  if (!w.lastAttemptAt) return <span className="badge badge-muted">untested</span>;
  if (w.lastError) return <span className="badge badge-danger">failing</span>;
  return <span className="badge badge-ok">delivering</span>;
}
