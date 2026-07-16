import { useState, type FormEvent, type ReactNode } from 'react';
import { useOutletContext } from 'react-router-dom';
import { Diff, Flame, Minus, Pencil, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { api, detailList, errorMessage, newIdempotencyKey, type StockRow } from '../api';
import { useAuth } from '../auth';
import { useAsync } from '../useAsync';
import { useDebounced } from '../useDebounced';
import {
  Alert,
  ConfirmModal,
  EmptyState,
  ErrorState,
  LinkedSerials,
  LoadingState,
  Modal,
  Pager,
  SearchInput,
  Spinner,
  num,
  useToast,
} from '../ui';
import type { GameContext } from './GameDetail';

const LIMIT = 50;

type RowAction = 'edit' | 'adjust' | 'decrease' | 'delete' | 'purge';

export function StockTab() {
  const { gameId, reloadGame } = useOutletContext<GameContext>();
  const { isOwner } = useAuth();
  const toast = useToast();

  const [q, setQ] = useState('');
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [offset, setOffset] = useState(0);
  const [creating, setCreating] = useState(false);
  const [action, setAction] = useState<{ kind: RowAction; row: StockRow } | null>(null);
  const search = useDebounced(q, 250);

  const stock = useAsync(
    (signal) => api.listStock(gameId, { q: search, includeDeleted, limit: LIMIT, offset }, signal),
    [gameId, search, includeDeleted, offset],
  );

  function done() {
    setAction(null);
    setCreating(false);
    stock.reload();
    reloadGame();
  }

  async function restore(row: StockRow) {
    try {
      // Restore is naturally idempotent (deleted_at := NULL), so a fresh key per click is
      // safe — unlike /adjust, replaying it can only reach the same state.
      await api.restoreStock(gameId, row.stockKey, newIdempotencyKey());
      toast.success(`Restored ${row.stockKey}.`);
      done();
    } catch (err) {
      toast.error(err);
    }
  }

  return (
    <div className="stack">
      <div className="row row-wrap">
        <SearchInput value={q} onChange={(v) => { setQ(v); setOffset(0); }} placeholder="Search stock keys…" />
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
          New stock key
        </button>
      </div>

      <div className="card">
        {stock.loading ? (
          <LoadingState label="Loading stock…" />
        ) : stock.error ? (
          <ErrorState error={stock.error} retry={stock.reload} />
        ) : !stock.data || stock.data.items.length === 0 ? (
          <EmptyState
            title={search ? 'No stock keys match' : 'No stock keys yet'}
            msg={
              search
                ? 'Try a different key.'
                : 'A stock key is created here, or by the game calling /get with expectedStock.'
            }
          />
        ) : (
          <>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Stock key</th>
                    <th className="num">Stock</th>
                    <th className="num">Max</th>
                    <th>Linked serials</th>
                    <th>State</th>
                    <th className="actions">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {stock.data.items.map((row) => (
                    <tr key={row.stockKey} className={row.deletedAt ? 'row-deleted' : undefined}>
                      <td className="cell-key">{row.stockKey}</td>
                      <td className="num">{num(row.stock)}</td>
                      <td className="num">{num(row.max)}</td>
                      <td>
                        {row.linkedSerials.length === 0 ? (
                          <span style={{ color: 'var(--fg-subtle)' }}>—</span>
                        ) : (
                          <span className="mono">{row.linkedSerials.join(', ')}</span>
                        )}
                      </td>
                      <td>
                        {row.deletedAt ? (
                          <span className="badge badge-danger">deleted</span>
                        ) : row.stock === 0 ? (
                          <span className="badge badge-warn">empty</span>
                        ) : (
                          <span className="badge badge-ok">live</span>
                        )}
                      </td>
                      <td className="actions">
                        <div className="row" style={{ justifyContent: 'flex-end' }}>
                          {row.deletedAt ? (
                            <IconBtn title="Restore" onClick={() => void restore(row)}>
                              <RotateCcw size={13} />
                            </IconBtn>
                          ) : (
                            <>
                              <IconBtn title="Edit stock and max" onClick={() => setAction({ kind: 'edit', row })}>
                                <Pencil size={13} />
                              </IconBtn>
                              <IconBtn title="Adjust by a delta" onClick={() => setAction({ kind: 'adjust', row })}>
                                <Diff size={13} />
                              </IconBtn>
                              <IconBtn title="Decrease" onClick={() => setAction({ kind: 'decrease', row })}>
                                <Minus size={13} />
                              </IconBtn>
                              <IconBtn title="Delete" danger onClick={() => setAction({ kind: 'delete', row })}>
                                <Trash2 size={13} />
                              </IconBtn>
                            </>
                          )}
                          {isOwner ? (
                            <IconBtn title="Purge permanently" danger onClick={() => setAction({ kind: 'purge', row })}>
                              <Flame size={13} />
                            </IconBtn>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager total={stock.data.total} limit={LIMIT} offset={offset} onOffset={setOffset} />
          </>
        )}
      </div>

      {creating ? <CreateStockDialog gameId={gameId} onClose={() => setCreating(false)} onDone={done} /> : null}

      {/* Each dialog is mounted on open and unmounted on close, which is what makes
          "one Idempotency-Key per submission" a structural property rather than a convention:
          the key lives in the dialog's own state. */}
      {action?.kind === 'edit' ? (
        <EditStockDialog gameId={gameId} row={action.row} onClose={() => setAction(null)} onDone={done} />
      ) : null}
      {action?.kind === 'adjust' ? (
        <AdjustDialog gameId={gameId} row={action.row} onClose={() => setAction(null)} onDone={done} />
      ) : null}
      {action?.kind === 'decrease' ? (
        <DecreaseDialog gameId={gameId} row={action.row} onClose={() => setAction(null)} onDone={done} />
      ) : null}
      {action?.kind === 'delete' ? (
        <DeleteStockDialog gameId={gameId} row={action.row} onClose={() => setAction(null)} onDone={done} />
      ) : null}
      {action?.kind === 'purge' ? (
        <PurgeStockDialog gameId={gameId} row={action.row} onClose={() => setAction(null)} onDone={done} />
      ) : null}
    </div>
  );
}

function IconBtn({
  title,
  onClick,
  danger,
  children,
}: {
  title: string;
  onClick: () => void;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      className="btn btn-sm btn-icon btn-ghost"
      title={title}
      aria-label={title}
      onClick={onClick}
      style={danger ? { color: 'var(--danger)' } : undefined}
    >
      {children}
    </button>
  );
}

/** Shared dialog chrome for the write forms. */
function FormDialog({
  title,
  submitLabel,
  busy,
  error,
  disabled,
  onSubmit,
  onClose,
  danger,
  children,
}: {
  title: string;
  submitLabel: string;
  busy: boolean;
  error: unknown;
  disabled?: boolean;
  onSubmit: (e: FormEvent) => void;
  onClose: () => void;
  danger?: boolean;
  children: ReactNode;
}) {
  const formId = `f-${title.replace(/\W+/g, '-')}`;
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`}
            type="submit"
            form={formId}
            disabled={busy || disabled}
          >
            {busy ? <Spinner size={14} /> : null}
            {submitLabel}
          </button>
        </>
      }
    >
      <form className="dialog-body" id={formId} onSubmit={onSubmit}>
        {error ? <Alert>{errorMessage(error)}</Alert> : null}
        {children}
      </form>
    </Modal>
  );
}

/** Surfaces the 409 that a soft-deleted key answers writes with, in the words the API uses. */
function DeletedHint({ error }: { error: unknown }) {
  return error && (error as { code?: string }).code === 'STOCK_KEY_DELETED' ? (
    <Alert kind="warn">This key is deleted. Restore it before writing to it.</Alert>
  ) : null;
}

function CreateStockDialog({ gameId, onClose, onDone }: { gameId: string; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  // Lazy initializer: called exactly once, when this dialog mounts — i.e. when it OPENS.
  // Every retry of this submission reuses it.
  const [idem] = useState(newIdempotencyKey);
  const [stockKey, setStockKey] = useState('');
  const [stock, setStock] = useState(0);
  const [max, setMax] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.createStock(gameId, { stockKey, stock, max }, idem);
      toast.success(`Created ${stockKey}.`);
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <FormDialog
      title="New stock key"
      submitLabel="Create"
      busy={busy}
      error={error}
      disabled={!stockKey || stock > max}
      onSubmit={submit}
      onClose={onClose}
    >
      <div className="field">
        <label className="label" htmlFor="sk">
          Stock key
        </label>
        <input
          id="sk"
          className="input mono"
          value={stockKey}
          onChange={(e) => setStockKey(e.target.value)}
          placeholder="excalibur"
          autoComplete="off"
          spellCheck={false}
          autoFocus
          required
          disabled={busy}
        />
        <span className="hint">Letters, numbers and : _ . - (max 128).</span>
      </div>
      <div className="row" style={{ gap: 'var(--sp-3)', alignItems: 'flex-start' }}>
        <div className="field" style={{ flex: 1 }}>
          <label className="label" htmlFor="st">
            Stock
          </label>
          <input
            id="st"
            className="input input-num"
            type="number"
            min={0}
            value={stock}
            onChange={(e) => setStock(Number(e.target.value))}
            required
            disabled={busy}
          />
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label className="label" htmlFor="mx">
            Max
          </label>
          <input
            id="mx"
            className="input input-num"
            type="number"
            min={0}
            value={max}
            onChange={(e) => setMax(Number(e.target.value))}
            required
            disabled={busy}
          />
        </div>
      </div>
      {stock > max ? <Alert kind="warn">Stock cannot exceed max.</Alert> : null}
    </FormDialog>
  );
}

function EditStockDialog({
  gameId,
  row,
  onClose,
  onDone,
}: {
  gameId: string;
  row: StockRow;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  // TWO keys, because this is two endpoints. One key across both would make the second call
  // look like a replay of the first to the ledger.
  const [idemStock] = useState(newIdempotencyKey);
  const [idemMax] = useState(newIdempotencyKey);
  const [stock, setStock] = useState(row.stock);
  const [max, setMax] = useState(row.max);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const changedStock = stock !== row.stock;
  const changedMax = max !== row.max;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // Max first: widening the ceiling before raising stock avoids a transient stock>max
      // rejection when both go up together.
      if (changedMax) await api.setMax(gameId, row.stockKey, max, idemMax);
      if (changedStock) await api.setStock(gameId, row.stockKey, stock, idemStock);
      toast.success(`Updated ${row.stockKey}.`);
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <FormDialog
      title={`Edit ${row.stockKey}`}
      submitLabel="Save"
      busy={busy}
      error={error}
      disabled={(!changedStock && !changedMax) || stock > max}
      onSubmit={submit}
      onClose={onClose}
    >
      <DeletedHint error={error} />
      <div className="row" style={{ gap: 'var(--sp-3)', alignItems: 'flex-start' }}>
        <div className="field" style={{ flex: 1 }}>
          <label className="label" htmlFor="est">
            Stock
          </label>
          <input
            id="est"
            className="input input-num"
            type="number"
            min={0}
            value={stock}
            onChange={(e) => setStock(Number(e.target.value))}
            autoFocus
            disabled={busy}
          />
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label className="label" htmlFor="emx">
            Max
          </label>
          <input
            id="emx"
            className="input input-num"
            type="number"
            min={0}
            value={max}
            onChange={(e) => setMax(Number(e.target.value))}
            disabled={busy}
          />
        </div>
      </div>
      {stock > max ? <Alert kind="warn">Stock cannot exceed max.</Alert> : null}
      <span className="hint">Sets absolute values. To move stock relative to what is there now, use Adjust.</span>
    </FormDialog>
  );
}

function AdjustDialog({
  gameId,
  row,
  onClose,
  onDone,
}: {
  gameId: string;
  row: StockRow;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [idem] = useState(newIdempotencyKey);
  const [delta, setDelta] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.adjustStock(gameId, row.stockKey, delta, idem);
      toast.success(`Adjusted ${row.stockKey} by ${delta > 0 ? '+' : ''}${delta}.`);
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const projected = row.stock + delta;

  return (
    <FormDialog
      title={`Adjust ${row.stockKey}`}
      submitLabel="Apply"
      busy={busy}
      error={error}
      disabled={delta === 0}
      onSubmit={submit}
      onClose={onClose}
    >
      <DeletedHint error={error} />
      <div className="field">
        <label className="label" htmlFor="delta">
          Delta
        </label>
        <input
          id="delta"
          className="input input-num"
          type="number"
          value={delta}
          onChange={(e) => setDelta(Number(e.target.value))}
          autoFocus
          disabled={busy}
        />
        <span className="hint">Signed. Negative removes stock, positive adds it. Must be non-zero.</span>
      </div>
      <div className="secret" style={{ borderStyle: 'solid' }}>
        <span style={{ color: 'var(--fg-muted)' }}>
          {num(row.stock)} → <strong style={{ color: 'var(--fg)' }}>{num(projected)}</strong> of {num(row.max)}
        </span>
      </div>
      {projected < 0 || projected > row.max ? (
        <Alert kind="warn">That lands outside 0–{num(row.max)}; the server will clamp or refuse it.</Alert>
      ) : null}
    </FormDialog>
  );
}

function DecreaseDialog({
  gameId,
  row,
  onClose,
  onDone,
}: {
  gameId: string;
  row: StockRow;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [idem] = useState(newIdempotencyKey);
  const [amount, setAmount] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.decreaseStock(gameId, row.stockKey, amount, idem);
      toast.success(`Decreased ${row.stockKey} by ${amount}.`);
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <FormDialog
      title={`Decrease ${row.stockKey}`}
      submitLabel="Decrease"
      busy={busy}
      error={error}
      disabled={amount < 1}
      onSubmit={submit}
      onClose={onClose}
    >
      <DeletedHint error={error} />
      <div className="field">
        <label className="label" htmlFor="amount">
          Amount
        </label>
        <input
          id="amount"
          className="input input-num"
          type="number"
          min={1}
          value={amount}
          onChange={(e) => setAmount(Number(e.target.value))}
          autoFocus
          disabled={busy}
        />
        <span className="hint">
          The same path the game takes. Current stock is {num(row.stock)}.
        </span>
      </div>
    </FormDialog>
  );
}

function DeleteStockDialog({
  gameId,
  row,
  onClose,
  onDone,
}: {
  gameId: string;
  row: StockRow;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [idem] = useState(newIdempotencyKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  // The list row already knows the links; the response repeats them for the toast.
  const linked = row.linkedSerials;

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const res = await api.deleteStock(gameId, row.stockKey, idem);
      toast.success(
        res.linkedSerials.length > 0
          ? `Deleted ${row.stockKey}. ${res.linkedSerials.length} linked serial(s) affected.`
          : `Deleted ${row.stockKey}.`,
      );
      onDone();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <ConfirmModal title={`Delete ${row.stockKey}?`} verb="Delete" busy={busy} onConfirm={() => void confirm()} onClose={onClose}>
      {error ? <Alert>{errorMessage(error)}</Alert> : null}
      <p>
        This is a soft delete. The key stops accepting writes from the game and can be restored here — the ledger and
        its history are kept.
      </p>
      <LinkedSerials keys={linked} />
    </ConfirmModal>
  );
}

function PurgeStockDialog({
  gameId,
  row,
  onClose,
  onDone,
}: {
  gameId: string;
  row: StockRow;
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
      // No Idempotency-Key: purge is a hard delete, so replaying it is a no-op by construction.
      const res = await api.purgeStock(gameId, row.stockKey, row.stockKey);
      toast.success(`Purged ${row.stockKey}. ${res.ledgerRowsDeleted.toLocaleString()} ledger row(s) deleted.`);
      onDone();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <ConfirmModal
      title={`Purge ${row.stockKey}`}
      verb="Purge permanently"
      purge
      confirmText={row.stockKey}
      busy={busy}
      onConfirm={() => void confirm()}
      onClose={onClose}
    >
      {error ? <Alert>{errorMessage(error)}</Alert> : null}
      <Alert>
        <strong>This cannot be undone.</strong> Unlike delete, purge destroys the row and its entire ledger history.
        There is no restore.
      </Alert>
      <LinkedSerials keys={row.linkedSerials} />
      {error ? <SeveredNote error={error} /> : null}
    </ConfirmModal>
  );
}

function SeveredNote({ error }: { error: unknown }) {
  const severed = detailList(error, 'severedSerials');
  if (severed.length === 0) return null;
  return (
    <Alert kind="warn">
      Serials left dangling: <span className="mono">{severed.join(', ')}</span>
    </Alert>
  );
}
