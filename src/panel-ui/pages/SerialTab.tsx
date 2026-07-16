import { useState, type FormEvent } from 'react';
import { useOutletContext } from 'react-router-dom';
import { Flame, Hash, Pencil, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { api, errorMessage, newIdempotencyKey, type SerialRow } from '../api';
import { useAuth } from '../auth';
import { useAsync } from '../useAsync';
import {
  Alert,
  ConfirmModal,
  EmptyState,
  ErrorState,
  LoadingState,
  Modal,
  Pager,
  Spinner,
  num,
  useToast,
} from '../ui';
import type { GameContext } from './GameDetail';

const LIMIT = 50;

type RowAction = 'edit' | 'issue' | 'delete' | 'purge';

export function SerialTab() {
  const { gameId, reloadGame } = useOutletContext<GameContext>();
  const { isOwner } = useAuth();
  const toast = useToast();

  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [offset, setOffset] = useState(0);
  const [creating, setCreating] = useState(false);
  const [action, setAction] = useState<{ kind: RowAction; row: SerialRow } | null>(null);

  // GET /serial takes no `q` — the contract has includeDeleted/limit/offset only.
  const serial = useAsync(
    (signal) => api.listSerial(gameId, { limit: LIMIT, offset, includeDeleted }, signal),
    [gameId, includeDeleted, offset],
  );

  function done() {
    setAction(null);
    setCreating(false);
    serial.reload();
    reloadGame();
  }

  async function restore(row: SerialRow) {
    try {
      await api.restoreSerial(gameId, row.serialKey, newIdempotencyKey());
      toast.success(`Restored ${row.serialKey}.`);
      done();
    } catch (err) {
      toast.error(err);
    }
  }

  return (
    <div className="stack">
      <div className="row row-wrap">
        <label className="check">
          <input
            type="checkbox"
            checked={includeDeleted}
            onChange={(e) => { setIncludeDeleted(e.target.checked); setOffset(0); }}
          />
          Show deleted
        </label>
        <div className="spacer" />
        <button className="btn btn-primary" onClick={() => setCreating(true)}>
          <Plus size={14} />
          New serial
        </button>
      </div>

      <div className="card">
        {serial.loading ? (
          <LoadingState label="Loading serials…" />
        ) : serial.error ? (
          <ErrorState error={serial.error} retry={serial.reload} />
        ) : !serial.data || serial.data.items.length === 0 ? (
          <EmptyState
            title="No serials yet"
            msg="A serial issues unique sequential numbers — edition numbers for a limited item."
          />
        ) : (
          <>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Serial key</th>
                    <th className="num">Next</th>
                    <th className="num">Issued</th>
                    <th className="num">Remaining</th>
                    <th className="num">Start</th>
                    <th className="num">Max</th>
                    <th>Linked stock</th>
                    <th>State</th>
                    <th className="actions">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {serial.data.items.map((row) => (
                    <tr key={row.serialKey} className={row.deletedAt ? 'row-deleted' : undefined}>
                      <td className="cell-key">{row.serialKey}</td>
                      <td className="num cell-strong">{num(row.next)}</td>
                      <td className="num">{num(row.issued)}</td>
                      <td className="num">{row.remaining === null ? '∞' : num(row.remaining)}</td>
                      <td className="num">{num(row.start)}</td>
                      <td className="num">{row.max === null ? '∞' : num(row.max)}</td>
                      <td>
                        {row.stockKey ? (
                          <span className="mono">{row.stockKey}</span>
                        ) : (
                          <span style={{ color: 'var(--fg-subtle)' }}>—</span>
                        )}
                      </td>
                      <td>
                        {row.deletedAt ? (
                          <span className="badge badge-danger">deleted</span>
                        ) : row.remaining === 0 ? (
                          <span className="badge badge-warn">exhausted</span>
                        ) : (
                          <span className="badge badge-ok">live</span>
                        )}
                      </td>
                      <td className="actions">
                        <div className="row" style={{ justifyContent: 'flex-end' }}>
                          {row.deletedAt ? (
                            <button
                              className="btn btn-sm btn-icon btn-ghost"
                              title="Restore"
                              aria-label="Restore"
                              onClick={() => void restore(row)}
                            >
                              <RotateCcw size={13} />
                            </button>
                          ) : (
                            <>
                              <button
                                className="btn btn-sm btn-icon btn-ghost"
                                title="Issue one serial"
                                aria-label="Issue one serial"
                                onClick={() => setAction({ kind: 'issue', row })}
                              >
                                <Hash size={13} />
                              </button>
                              <button
                                className="btn btn-sm btn-icon btn-ghost"
                                title="Edit"
                                aria-label="Edit"
                                onClick={() => setAction({ kind: 'edit', row })}
                              >
                                <Pencil size={13} />
                              </button>
                              <button
                                className="btn btn-sm btn-icon btn-ghost"
                                title="Delete"
                                aria-label="Delete"
                                style={{ color: 'var(--danger)' }}
                                onClick={() => setAction({ kind: 'delete', row })}
                              >
                                <Trash2 size={13} />
                              </button>
                            </>
                          )}
                          {isOwner ? (
                            <button
                              className="btn btn-sm btn-icon btn-ghost"
                              title="Purge permanently"
                              aria-label="Purge permanently"
                              style={{ color: 'var(--danger)' }}
                              onClick={() => setAction({ kind: 'purge', row })}
                            >
                              <Flame size={13} />
                            </button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager total={serial.data.total} limit={LIMIT} offset={offset} onOffset={setOffset} />
          </>
        )}
      </div>

      {creating ? <CreateSerialDialog gameId={gameId} onClose={() => setCreating(false)} onDone={done} /> : null}
      {action?.kind === 'edit' ? (
        <EditSerialDialog gameId={gameId} row={action.row} onClose={() => setAction(null)} onDone={done} />
      ) : null}
      {action?.kind === 'issue' ? (
        <IssueDialog gameId={gameId} row={action.row} onClose={() => setAction(null)} onDone={done} />
      ) : null}
      {action?.kind === 'delete' ? (
        <DeleteSerialDialog gameId={gameId} row={action.row} onClose={() => setAction(null)} onDone={done} />
      ) : null}
      {action?.kind === 'purge' ? (
        <PurgeSerialDialog gameId={gameId} row={action.row} onClose={() => setAction(null)} onDone={done} />
      ) : null}
    </div>
  );
}

function CreateSerialDialog({ gameId, onClose, onDone }: { gameId: string; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [idem] = useState(newIdempotencyKey);
  const [serialKey, setSerialKey] = useState('');
  const [start, setStart] = useState(1);
  const [capped, setCapped] = useState(false);
  const [max, setMax] = useState(100);
  const [linked, setLinked] = useState(false);
  const [stockKey, setStockKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.createSerial(
        gameId,
        { serialKey, start, max: capped ? max : null, stockKey: linked && stockKey ? stockKey : null },
        idem,
      );
      toast.success(`Created ${serialKey}.`);
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="New serial"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            type="submit"
            form="create-serial"
            disabled={busy || !serialKey || (capped && max < start)}
          >
            {busy ? <Spinner size={14} /> : null}
            Create
          </button>
        </>
      }
    >
      <form className="dialog-body" id="create-serial" onSubmit={submit}>
        {error ? <Alert>{errorMessage(error)}</Alert> : null}

        <div className="field">
          <label className="label" htmlFor="serialKey">
            Serial key
          </label>
          <input
            id="serialKey"
            className="input mono"
            value={serialKey}
            onChange={(e) => setSerialKey(e.target.value)}
            placeholder="excalibur-edition"
            autoComplete="off"
            spellCheck={false}
            autoFocus
            required
            disabled={busy}
          />
        </div>

        <div className="field">
          <label className="label" htmlFor="start">
            Start at
          </label>
          <input
            id="start"
            className="input input-num"
            type="number"
            min={0}
            value={start}
            onChange={(e) => setStart(Number(e.target.value))}
            required
            disabled={busy}
          />
          <span className="hint">The first number this serial will issue.</span>
        </div>

        <div className="field">
          <label className="check">
            <input type="checkbox" checked={capped} onChange={(e) => setCapped(e.target.checked)} disabled={busy} />
            Cap the highest number
          </label>
          {capped ? (
            <>
              <input
                className="input input-num"
                type="number"
                min={start}
                value={max}
                onChange={(e) => setMax(Number(e.target.value))}
                disabled={busy}
                aria-label="Max"
              />
              {max < start ? <Alert kind="warn">Max must be at least the start value.</Alert> : null}
            </>
          ) : (
            <span className="hint">Uncapped — issues forever.</span>
          )}
        </div>

        <div className="field">
          <label className="check">
            <input type="checkbox" checked={linked} onChange={(e) => setLinked(e.target.checked)} disabled={busy} />
            Link to a stock key
          </label>
          {linked ? (
            <input
              className="input mono"
              value={stockKey}
              onChange={(e) => setStockKey(e.target.value)}
              placeholder="excalibur"
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
              aria-label="Stock key"
            />
          ) : (
            <span className="hint">Unlinked — issuing does not touch stock.</span>
          )}
        </div>
      </form>
    </Modal>
  );
}

function EditSerialDialog({
  gameId,
  row,
  onClose,
  onDone,
}: {
  gameId: string;
  row: SerialRow;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [idem] = useState(newIdempotencyKey);
  const [capped, setCapped] = useState(row.max !== null);
  const [max, setMax] = useState(row.max ?? row.next);
  const [linked, setLinked] = useState(row.stockKey !== null);
  const [stockKey, setStockKey] = useState(row.stockKey ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const nextMax = capped ? max : null;
  const nextStock = linked ? stockKey : null;
  const changed = nextMax !== row.max || nextStock !== row.stockKey;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // null is meaningful here (uncap / unlink) and undefined means "leave alone", so only
      // the fields that actually changed are sent.
      await api.updateSerial(
        gameId,
        row.serialKey,
        {
          ...(nextMax !== row.max ? { max: nextMax } : {}),
          ...(nextStock !== row.stockKey ? { stockKey: nextStock } : {}),
        },
        idem,
      );
      toast.success(`Updated ${row.serialKey}.`);
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Edit ${row.serialKey}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-primary" type="submit" form="edit-serial" disabled={busy || !changed}>
            {busy ? <Spinner size={14} /> : null}
            Save
          </button>
        </>
      }
    >
      <form className="dialog-body" id="edit-serial" onSubmit={submit}>
        {error ? <Alert>{errorMessage(error)}</Alert> : null}
        {error && (error as { code?: string }).code === 'SERIAL_NOT_FOUND' ? (
          <Alert kind="warn">This serial was deleted. Restore it, or re-create it.</Alert>
        ) : null}

        <div className="hint">
          Next issues <strong className="num">{num(row.next)}</strong>; {num(row.issued)} issued so far. Start
          ({num(row.start)}) is immutable.
        </div>

        <div className="field">
          <label className="check">
            <input type="checkbox" checked={capped} onChange={(e) => setCapped(e.target.checked)} disabled={busy} />
            Cap the highest number
          </label>
          {capped ? (
            <input
              className="input input-num"
              type="number"
              min={1}
              value={max}
              onChange={(e) => setMax(Number(e.target.value))}
              disabled={busy}
              aria-label="Max"
            />
          ) : (
            <span className="hint">Uncapped — issues forever.</span>
          )}
        </div>

        <div className="field">
          <label className="check">
            <input type="checkbox" checked={linked} onChange={(e) => setLinked(e.target.checked)} disabled={busy} />
            Link to a stock key
          </label>
          {linked ? (
            <input
              className="input mono"
              value={stockKey}
              onChange={(e) => setStockKey(e.target.value)}
              placeholder="excalibur"
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
              aria-label="Stock key"
            />
          ) : (
            <span className="hint">Unlinked — issuing does not touch stock.</span>
          )}
        </div>
      </form>
    </Modal>
  );
}

/**
 * Issuing is the one read-write op with no natural idempotency: it consumes a number. The key
 * is minted when this dialog opens, so pressing Issue twice REPLAYS (same number back, with
 * replayed:true) rather than burning a second number.
 */
function IssueDialog({
  gameId,
  row,
  onClose,
  onDone,
}: {
  gameId: string;
  row: SerialRow;
  onClose: () => void;
  onDone: () => void;
}) {
  const [idem] = useState(newIdempotencyKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<{ serial: number; remaining: number | null; replayed: boolean } | null>(null);

  async function issue() {
    setBusy(true);
    setError(null);
    try {
      setResult(await api.issueSerial(gameId, row.serialKey, idem));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Issue from ${row.serialKey}`}
      onClose={() => {
        if (result) onDone();
        else onClose();
      }}
      footer={
        result ? (
          <button className="btn btn-primary" onClick={onDone}>
            Done
          </button>
        ) : (
          <>
            <button className="btn" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button className="btn btn-primary" onClick={() => void issue()} disabled={busy || row.remaining === 0}>
              {busy ? <Spinner size={14} /> : null}
              Issue one
            </button>
          </>
        )
      }
    >
      <div className="dialog-body">
        {error ? <Alert>{errorMessage(error)}</Alert> : null}

        {result ? (
          <>
            <div className="stat">
              <div className="stat-label">Issued serial</div>
              <div className="stat-value">#{result.serial.toLocaleString()}</div>
            </div>
            <div className="hint">
              {result.remaining === null ? 'Uncapped.' : `${num(result.remaining)} remaining.`}
              {result.replayed ? ' This was a replay of the same request — no new number was consumed.' : ''}
            </div>
          </>
        ) : (
          <>
            <p>
              Consumes the next number ({<strong className="num">{num(row.next)}</strong>}) from this serial. This is
              the same path the game takes.
            </p>
            {row.remaining === 0 ? <Alert kind="warn">This serial is exhausted — nothing left to issue.</Alert> : null}
            {row.stockKey ? (
              <Alert kind="info">
                Linked to stock <span className="mono">{row.stockKey}</span>, which this will draw down.
              </Alert>
            ) : null}
          </>
        )}
      </div>
    </Modal>
  );
}

function DeleteSerialDialog({
  gameId,
  row,
  onClose,
  onDone,
}: {
  gameId: string;
  row: SerialRow;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [idem] = useState(newIdempotencyKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await api.deleteSerial(gameId, row.serialKey, idem);
      toast.success(`Deleted ${row.serialKey}.`);
      onDone();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <ConfirmModal
      title={`Delete ${row.serialKey}?`}
      verb="Delete"
      busy={busy}
      onConfirm={() => void confirm()}
      onClose={onClose}
    >
      {error ? <Alert>{errorMessage(error)}</Alert> : null}
      <p>
        A soft delete: the game can no longer issue from it, and it can be restored here. The counter keeps its place
        at {num(row.next)}.
      </p>
      {row.stockKey ? (
        <Alert kind="warn">
          Linked to stock <span className="mono">{row.stockKey}</span>.
        </Alert>
      ) : null}
    </ConfirmModal>
  );
}

function PurgeSerialDialog({
  gameId,
  row,
  onClose,
  onDone,
}: {
  gameId: string;
  row: SerialRow;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await api.purgeSerial(gameId, row.serialKey, row.serialKey);
      toast.success(`Purged ${row.serialKey}.`);
      onDone();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <ConfirmModal
      title={`Purge ${row.serialKey}`}
      verb="Purge permanently"
      purge
      confirmText={row.serialKey}
      busy={busy}
      onConfirm={() => void confirm()}
      onClose={onClose}
    >
      {error ? <Alert>{errorMessage(error)}</Alert> : null}
      <Alert>
        <strong>This cannot be undone.</strong> The serial and its issue history are destroyed. Numbers already handed
        out to players stay handed out — nothing reclaims them.
      </Alert>
    </ConfirmModal>
  );
}
