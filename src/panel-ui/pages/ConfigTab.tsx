import { useState, type FormEvent } from 'react';
import { useOutletContext } from 'react-router-dom';
import { History, Pencil, Plus, RotateCcw, Trash2, Undo2, Upload } from 'lucide-react';
import {
  api,
  errorMessage,
  isApiError,
  type ConfigChange,
  type ConfigEntry,
  type ConfigEntryInput,
  type ConfigState,
  type ConfigType,
} from '../api';
import { JsonEditor } from '../json';
import { Luau } from '../luau';
import { useAsync } from '../useAsync';
import {
  Alert,
  CollapsibleCard,
  ConfirmModal,
  CopyButton,
  EmptyState,
  ErrorState,
  LoadingState,
  Modal,
  Pager,
  Spinner,
  TimeCell,
  useToast,
} from '../ui';
import type { GameContext } from './GameDetail';

const TYPES: ConfigType[] = ['string', 'number', 'boolean', 'json'];

/** One line in a table cell. JSON compact, strings quoted so an empty or padded value is visible. */
function preview(type: ConfigType, value: unknown): string {
  if (type === 'string') return JSON.stringify(value);
  if (type === 'json') return JSON.stringify(value);
  return String(value);
}

type RowStatus = 'new' | 'changed' | 'removed' | 'description' | null;

function statusOf(change: ConfigChange | undefined): RowStatus {
  if (!change) return null;
  if (change.descriptionOnly) return 'description';
  if (change.before === null) return 'new';
  if (change.after === null) return 'removed';
  return 'changed';
}

const STATUS_BADGE: Record<Exclude<RowStatus, null>, [string, string]> = {
  new: ['badge-ok', 'new'],
  changed: ['badge-warn', 'changed'],
  removed: ['badge-danger', 'removed'],
  description: ['badge-muted', 'description'],
};

/**
 * Live configs: values the game reads at runtime, changed here without republishing.
 *
 * Every edit lands in a draft; nothing reaches a game until Publish, which cuts a numbered version.
 * Writes carry the draftRevision this screen loaded, so two people editing at once get a clear
 * "reload" instead of one silently undoing the other.
 */
export function ConfigTab() {
  const { gameId, reloadGame } = useOutletContext<GameContext>();
  const toast = useToast();
  const state = useAsync((signal) => api.getConfigState(gameId, signal), [gameId]);
  const [historyNonce, setHistoryNonce] = useState(0);

  const [editing, setEditing] = useState<{ key: string | null; entry: ConfigEntry | null } | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [discardBusy, setDiscardBusy] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  if (state.loading && !state.data) return <LoadingState label="Loading configs…" />;
  if (state.error && !state.data) return <ErrorState error={state.error} retry={state.reload} />;
  const s = state.data!;

  const working = s.draft ?? s.published;
  const changes = s.changes;
  const changeCount = Object.values(changes).length;
  // Removed keys are not in the working set, but they must stay visible until published.
  const keys = [...new Set([...Object.keys(working), ...Object.keys(changes)])].sort();

  /** Every write goes through here: one place for the conflict message and the reload. */
  async function write(run: () => Promise<ConfigState>, done?: string): Promise<boolean> {
    try {
      const next = await run();
      state.setData(() => next);
      reloadGame(); // the tab's config count
      if (done) toast.success(done);
      return true;
    } catch (err) {
      if (isApiError(err, 'CONFLICT') && /changed since you loaded/.test(errorMessage(err))) {
        toast.error(new Error('Someone else edited the draft meanwhile — reloaded. Apply your change again.'));
        state.reload();
      } else {
        toast.error(err);
      }
      return false;
    }
  }

  async function removeKey(key: string) {
    setBusyKey(key);
    await write(() => api.patchConfigDraft(gameId, { [key]: null }, s.draftRevision));
    setBusyKey(null);
  }

  async function undo(key: string) {
    const published = s.published[key];
    setBusyKey(key);
    await write(() => api.patchConfigDraft(gameId, { [key]: published ?? null }, s.draftRevision));
    setBusyKey(null);
  }

  return (
    <div className="stack">
      <div className="card">
        <div className="card-body row row-wrap">
          <div className="stack" style={{ gap: 2, flex: 1, minWidth: 0 }}>
            <div className="card-title">
              {s.version === 0 ? 'Nothing published yet' : `Live config · version ${s.version}`}
            </div>
            <div className="hint">
              {s.version === 0 ? (
                'Add configs below, then publish. Games read them with api:getConfigAsync().'
              ) : (
                <>
                  Published <TimeCell iso={s.publishedAt} />
                  {s.publishedBy ? ` by ${s.publishedBy}` : ''} · {Object.keys(s.published).length} keys
                </>
              )}
            </div>
          </div>
          <button type="button" className="btn btn-primary" onClick={() => setEditing({ key: null, entry: null })}>
            <Plus size={14} />
            Add config
          </button>
        </div>
      </div>

      {s.draft ? (
        <div className="card config-draft">
          <div className="card-body row row-wrap">
            <div className="stack" style={{ gap: 2, flex: 1, minWidth: 0 }}>
              <div className="card-title">
                Draft · {changeCount} change{changeCount === 1 ? '' : 's'} not live yet
              </div>
              <div className="hint">
                Edited <TimeCell iso={s.draftUpdatedAt} />
                {s.draftUpdatedBy ? ` by ${s.draftUpdatedBy}` : ''}. Games keep reading version {s.version} until you publish.
              </div>
            </div>
            <button type="button" className="btn" onClick={() => setDiscarding(true)}>
              Discard
            </button>
            <button type="button" className="btn btn-primary" onClick={() => setPublishing(true)}>
              <Upload size={14} />
              Publish…
            </button>
          </div>
        </div>
      ) : null}

      <div className="card">
        {keys.length === 0 ? (
          <EmptyState
            title="No configs"
            msg="A config is a named value your game reads live — a feature flag, a price, a drop rate."
            action={
              <button type="button" className="btn btn-sm" onClick={() => setEditing({ key: null, entry: null })}>
                <Plus size={13} />
                Add config
              </button>
            }
          />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Key</th>
                  <th>Type</th>
                  <th>Value</th>
                  <th>Description</th>
                  <th>Updated</th>
                  <th className="actions">Actions</th>
                </tr>
              </thead>
              <tbody>
                {keys.map((key) => {
                  const status = statusOf(changes[key]);
                  const entry = working[key] ?? s.published[key]!;
                  const removed = status === 'removed';
                  return (
                    <tr key={key} className={removed ? 'row-deleted' : undefined}>
                      <td>
                        <span className="cell-key">{key}</span>
                        {status ? (
                          <span className={`badge ${STATUS_BADGE[status][0]}`} style={{ marginLeft: 8 }}>
                            {STATUS_BADGE[status][1]}
                          </span>
                        ) : null}
                      </td>
                      <td>
                        <span className="badge badge-muted">{entry.type}</span>
                      </td>
                      <td>
                        <span className="mono config-value" title={preview(entry.type, entry.value)}>
                          {preview(entry.type, entry.value)}
                        </span>
                        {status === 'changed' && changes[key]!.before ? (
                          <div className="hint mono config-was">was {preview(changes[key]!.before!.type, changes[key]!.before!.value)}</div>
                        ) : null}
                      </td>
                      <td className="hint">{entry.description || '—'}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>{entry.updatedAt ? <TimeCell iso={entry.updatedAt} /> : <span className="hint">—</span>}</td>
                      <td className="actions">
                        {busyKey === key ? (
                          <Spinner size={14} />
                        ) : busyKey !== null ? null : (
                          <div className="row" style={{ justifyContent: 'flex-end', gap: 4 }}>
                            {status ? (
                              <button type="button" className="btn btn-sm btn-ghost" title="Undo this change" onClick={() => void undo(key)}>
                                <Undo2 size={14} />
                              </button>
                            ) : null}
                            {!removed ? (
                              <>
                                <button type="button" className="btn btn-sm btn-icon btn-ghost" title="Edit" onClick={() => setEditing({ key, entry })}>
                                  <Pencil size={14} />
                                </button>
                                <button type="button" className="btn btn-sm btn-icon btn-ghost" title="Remove" onClick={() => void removeKey(key)}>
                                  <Trash2 size={14} />
                                </button>
                              </>
                            ) : null}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <HistoryCard
        key={historyNonce}
        gameId={gameId}
        onRestore={async (version) => {
          const ok = await write(() => api.restoreConfigRevision(gameId, version, s.draftRevision), `Version ${version} staged as the draft. Publish to make it live.`);
          return ok;
        }}
      />

      <UsageCard gameId={gameId} sampleKey={keys[0]} />

      {editing ? (
        <EntryDialog
          existingKeys={Object.keys(working)}
          editKey={editing.key}
          entry={editing.entry}
          onClose={() => setEditing(null)}
          onSave={async (key, input) => {
            const ok = await write(() => api.patchConfigDraft(gameId, { [key]: input }, s.draftRevision), `"${key}" staged in the draft.`);
            if (ok) setEditing(null);
          }}
        />
      ) : null}

      {publishing ? (
        <PublishDialog
          state={s}
          onClose={() => setPublishing(false)}
          onPublish={async (message) => {
            try {
              const r = await api.publishConfig(gameId, message, s.draftRevision);
              state.setData(() => r.state);
              setHistoryNonce((n) => n + 1);
              setPublishing(false);
              toast.success(`Version ${r.version} is live. Game servers pick it up within their next check (~15s).`);
            } catch (err) {
              toast.error(err);
              state.reload();
            }
          }}
        />
      ) : null}

      {discarding ? (
        <ConfirmModal
          title="Discard the draft?"
          verb="Discard"
          busy={discardBusy}
          onClose={() => setDiscarding(false)}
          onConfirm={() => {
            // busy, or a double-click sends a second DELETE with the now-stale revision and reads as
            // "someone else edited the draft".
            setDiscardBusy(true);
            void write(() => api.discardConfigDraft(gameId, s.draftRevision), 'Draft discarded.').then(() => {
              setDiscardBusy(false);
              setDiscarding(false);
            });
          }}
        >
          <p>
            All {changeCount} unpublished change{changeCount === 1 ? '' : 's'} are thrown away. What games read is not affected —
            they keep version {s.version}.
          </p>
        </ConfirmModal>
      ) : null}
    </div>
  );
}

function EntryDialog({
  existingKeys,
  editKey,
  entry,
  onClose,
  onSave,
}: {
  existingKeys: string[];
  editKey: string | null;
  entry: ConfigEntry | null;
  onClose: () => void;
  onSave: (key: string, input: ConfigEntryInput) => Promise<void>;
}) {
  const [key, setKey] = useState(editKey ?? '');
  const [type, setType] = useState<ConfigType>(entry?.type ?? 'boolean');
  const [text, setText] = useState(() => {
    if (!entry) return '';
    if (entry.type === 'json') return JSON.stringify(entry.value, null, 2);
    return String(entry.value);
  });
  const [bool, setBool] = useState(entry?.type === 'boolean' ? entry.value === true : true);
  const [description, setDescription] = useState(entry?.description ?? '');
  const [busy, setBusy] = useState(false);

  const keyTaken = editKey === null && existingKeys.includes(key);
  const keyValid = /^[A-Za-z][A-Za-z0-9_.-]{0,99}$/.test(key);

  // Parse as the user types, so the error is next to the field instead of a round-trip later.
  let value: unknown = null;
  let problem: string | null = null;
  if (type === 'boolean') value = bool;
  else if (type === 'string') value = text;
  else if (type === 'number') {
    value = Number(text);
    if (text.trim() === '' || !Number.isFinite(value)) problem = 'Enter a number.';
  } else {
    try {
      value = JSON.parse(text);
      if (value === null || typeof value !== 'object') problem = 'JSON must be an object {…} or an array […].';
    } catch (err) {
      // The browser's own message says where it broke ("… at line 3 column 5"), which a bare
      // "Not valid JSON." does not.
      problem = text.trim() === '' ? 'Enter a JSON object or array.' : `Not valid JSON — ${errorMessage(err)}`;
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    await onSave(key, { type, value, description: description.trim() || undefined });
    setBusy(false);
  }

  return (
    <Modal
      title={editKey ? `Edit ${editKey}` : 'Add config'}
      wide={type === 'json' || type === 'string'}
      onClose={onClose}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-primary" type="submit" form="config-entry" disabled={busy || !keyValid || keyTaken || problem !== null}>
            {busy ? <Spinner size={14} /> : null}
            Stage in draft
          </button>
        </>
      }
    >
      <form className="dialog-body" id="config-entry" onSubmit={submit}>
        <div className="field">
          <label className="label" htmlFor="cfg-key">
            Key
          </label>
          <input
            id="cfg-key"
            className="input mono"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="bossHealth"
            autoComplete="off"
            spellCheck={false}
            autoFocus={!editKey}
            disabled={busy || editKey !== null}
          />
          <span className="hint">
            {keyTaken
              ? 'That key already exists — edit it from the table instead.'
              : 'What the game passes to GetValue. Starts with a letter; letters, digits, _ . - (max 100).'}
          </span>
        </div>

        <div className="field">
          <span className="label">Type</span>
          <div className="seg" role="group" aria-label="Type" style={{ alignSelf: 'flex-start' }}>
            {TYPES.map((t) => (
              <button key={t} type="button" className="seg-btn" aria-pressed={t === type} onClick={() => setType(t)} disabled={busy}>
                {t}
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <div className="row">
            <label className="label" htmlFor="cfg-value">
              Value
            </label>
            <div className="spacer" />
            {type === 'json' ? (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setText(JSON.stringify(value, null, 2))}
                disabled={busy || problem !== null}
              >
                Format
              </button>
            ) : null}
          </div>
          {type === 'boolean' ? (
            <div className="seg" role="group" aria-label="Value" style={{ alignSelf: 'flex-start' }}>
              {[true, false].map((b) => (
                <button key={String(b)} type="button" className="seg-btn" aria-pressed={bool === b} onClick={() => setBool(b)} disabled={busy}>
                  {String(b)}
                </button>
              ))}
            </div>
          ) : type === 'number' ? (
            <input
              id="cfg-value"
              className="input input-num"
              inputMode="decimal"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="500"
              disabled={busy}
            />
          ) : type === 'json' ? (
            <JsonEditor
              id="cfg-value"
              value={text}
              onChange={setText}
              placeholder={'{\n  "sword": 120,\n  "shield": 80\n}'}
              disabled={busy}
            />
          ) : (
            <textarea
              id="cfg-value"
              className="input config-textarea"
              rows={4}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Any text"
              disabled={busy}
            />
          )}
          {problem && text !== '' ? <span className="hint" style={{ color: 'var(--danger)' }}>{problem}</span> : null}
        </div>

        <div className="field">
          <label className="label" htmlFor="cfg-desc">
            Description <span style={{ color: 'var(--fg-subtle)', fontWeight: 400 }}>— optional</span>
          </label>
          <input
            id="cfg-desc"
            className="input"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={500}
            placeholder="What this controls, for whoever edits it next"
            disabled={busy}
          />
        </div>
      </form>
    </Modal>
  );
}

function ChangeList({ changes }: { changes: Record<string, ConfigChange> }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Key</th>
            <th>Before</th>
            <th>After</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(changes).map(([key, c]) => (
            <tr key={key}>
              <td>
                <span className="cell-key">{key}</span>
                {c.descriptionOnly ? <span className="badge badge-muted" style={{ marginLeft: 8 }}>description</span> : null}
              </td>
              <td className="mono config-value">{c.before ? preview(c.before.type, c.before.value) : <span className="hint">—</span>}</td>
              <td className="mono config-value">{c.after ? preview(c.after.type, c.after.value) : <span className="hint">removed</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PublishDialog({
  state,
  onClose,
  onPublish,
}: {
  state: ConfigState;
  onClose: () => void;
  onPublish: (message: string) => Promise<void>;
}) {
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  return (
    <Modal
      title={`Publish version ${state.version + 1}`}
      wide
      onClose={onClose}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            type="button"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void onPublish(message.trim()).finally(() => setBusy(false));
            }}
          >
            {busy ? <Spinner size={14} /> : <Upload size={14} />}
            Publish to games
          </button>
        </>
      }
    >
      <div className="dialog-body">
        <Alert kind="info">
          Every live server gets these values on its next check (the Luau client checks every 15 seconds). Snapshots
          change when the game calls Refresh.
        </Alert>
        <ChangeList changes={state.changes} />
        <div className="field">
          <label className="label" htmlFor="cfg-msg">
            Message <span style={{ color: 'var(--fg-subtle)', fontWeight: 400 }}>— shown in history</span>
          </label>
          <input
            id="cfg-msg"
            className="input"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            maxLength={500}
            placeholder="Halloween: tougher boss, cheaper swords"
            autoFocus
            disabled={busy}
          />
        </div>
      </div>
    </Modal>
  );
}

/** A version's before/after values, fetched when opened — the list only carries key names. */
function RevisionChanges({ gameId, version }: { gameId: string; version: number }) {
  const detail = useAsync((signal) => api.getConfigRevision(gameId, version, signal), [gameId, version]);
  if (detail.loading && !detail.data) return <LoadingState label="Loading changes…" />;
  if (detail.error || !detail.data) return <ErrorState error={detail.error} retry={detail.reload} />;
  return <ChangeList changes={detail.data.changes} />;
}

const HISTORY_PAGE = 10;

function HistoryCard({ gameId, onRestore }: { gameId: string; onRestore: (version: number) => Promise<boolean> }) {
  const [offset, setOffset] = useState(0);
  const [open, setOpen] = useState<number | null>(null);
  const [restoring, setRestoring] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const revisions = useAsync((signal) => api.listConfigRevisions(gameId, { limit: HISTORY_PAGE, offset }, signal), [gameId, offset]);

  const total = revisions.data?.total ?? 0;
  return (
    <CollapsibleCard title={`History${total ? ` (${total})` : ''}`} icon={<History size={15} style={{ color: 'var(--accent)' }} />}>
      {revisions.loading && !revisions.data ? (
        <LoadingState label="Loading history…" />
      ) : revisions.error ? (
        <ErrorState error={revisions.error} retry={revisions.reload} />
      ) : total === 0 ? (
        <div className="hint">No versions yet — publishing creates version 1.</div>
      ) : (
        <>
          <div className="stack" style={{ gap: 'var(--sp-2)' }}>
            {revisions.data!.items.map((r) => {
              const n = r.changedKeys.length;
              return (
                <div key={r.version} className="config-revision">
                  <div className="row row-wrap">
                    <span className="badge badge-owner">v{r.version}</span>
                    <span className="cell-strong" style={{ flex: 1, minWidth: 160 }}>
                      {r.message || <span className="hint">No message</span>}
                    </span>
                    <span className="hint">
                      <TimeCell iso={r.publishedAt} />
                      {r.publishedBy ? ` · ${r.publishedBy}` : ''} · {n} change{n === 1 ? '' : 's'}
                    </span>
                    <button type="button" className="btn btn-sm btn-ghost" onClick={() => setOpen(open === r.version ? null : r.version)}>
                      {open === r.version ? 'Hide' : 'Show'} changes
                    </button>
                    <button type="button" className="btn btn-sm" onClick={() => setRestoring(r.version)}>
                      <RotateCcw size={13} />
                      Restore
                    </button>
                  </div>
                  {open === r.version ? <RevisionChanges gameId={gameId} version={r.version} /> : null}
                </div>
              );
            })}
          </div>
          <Pager total={total} limit={HISTORY_PAGE} offset={offset} onOffset={setOffset} />
        </>
      )}

      {restoring !== null ? (
        <ConfirmModal
          title={`Restore version ${restoring}?`}
          verb="Stage it"
          danger={false}
          busy={busy}
          onClose={() => setRestoring(null)}
          onConfirm={() => {
            setBusy(true);
            void onRestore(restoring)
              .then((ok) => {
                if (ok) setRestoring(null);
              })
              .finally(() => setBusy(false));
          }}
        >
          <p>
            Version {restoring}'s full config replaces the current draft (any unpublished edits are lost). It does
            <strong> not</strong> go live until you publish it.
          </p>
        </ConfirmModal>
      ) : null}
    </CollapsibleCard>
  );
}

function UsageCard({ gameId, sampleKey }: { gameId: string; sampleKey: string | undefined }) {
  const key = sampleKey ?? 'bossHealth';
  const code = `--!strict
-- ServerScriptService/Configs.server.lua
local ServerScriptService = game:GetService("ServerScriptService")
local GameApi = require(ServerScriptService.GameApiClient)

local api = GameApi.new({
\tbaseUrl = "${window.location.origin}/v1",
\tapiKey = "gk_xxxxxxxxxxxx.<secret>", -- needs the config:read scope
\tgameId = "${gameId}",
})

-- Same shape as Roblox's ConfigService. Yields once; raises only if the
-- config has never loaded, so give the game a fallback.
local ok, config = pcall(api.getConfigAsync, api)
if not ok then
\twarn("configs unavailable, using defaults:", config)
\treturn
end

print("${key} =", config:GetValue("${key}"))

-- A publish marks the snapshot outdated. Refresh when it suits the game —
-- right away here, or between rounds so values never change mid-match.
config.UpdateAvailable:Connect(function()
\tconfig:Refresh()
end)

config:GetValueChangedSignal("${key}"):Connect(function(newValue)
\tprint("${key} changed to", newValue)
end)

-- Try a value on THIS server only, without publishing:
-- api:setConfigTestingValue("${key}", 200)`;

  return (
    <CollapsibleCard title="Use it in your game" actions={<CopyButton value={code} label="Copy script" />}>
      <div className="hint">
        The Luau client checks for a new version every 15 seconds (<span className="mono">configPollSeconds</span>) and
        downloads the config only when it changed.
      </div>
      <Luau code={code} />
    </CollapsibleCard>
  );
}
