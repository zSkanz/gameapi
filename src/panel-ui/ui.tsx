import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Copy,
  Info,
  Inbox,
  KeyRound,
  Loader2,
  Search,
  XCircle,
} from 'lucide-react';
import { errorMessage } from './api';

// ---- toasts ----
type ToastKind = 'success' | 'error' | 'info';
interface Toast {
  id: number;
  kind: ToastKind;
  msg: string;
}

interface ToastApi {
  success: (msg: string) => void;
  error: (err: unknown) => void;
  info: (msg: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast outside ToastProvider');
  return ctx;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(0);

  const push = useCallback((kind: ToastKind, msg: string) => {
    const id = next.current++;
    setToasts((t) => [...t, { id, kind, msg }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 7000 : 4000);
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      success: (msg) => push('success', msg),
      info: (msg) => push('info', msg),
      // Takes the error itself, not a string: a caught ApiError already carries the server's
      // message, and re-deriving one at each catch site is how they drift.
      error: (err) => push('error', errorMessage(err)),
    }),
    [push],
  );

  const icon = { success: CheckCircle2, error: XCircle, info: Info };

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => {
          const Icon = icon[t.kind];
          return (
            <div key={t.id} className={`toast toast-${t.kind}`}>
              <Icon size={15} />
              <span className="toast-msg">{t.msg}</span>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

// ---- dialog ----
/**
 * Native <dialog> driven by showModal(). React renders the markup; the browser supplies the
 * focus trap, Escape-to-close, the inert background and top-layer stacking. `onClose` fires
 * for Escape too, so the parent's open-state stays in sync however it was dismissed.
 */
export function Modal({
  title,
  icon,
  onClose,
  children,
  footer,
  wide,
  dismissable = true,
}: {
  title: string;
  icon?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  /** false = backdrop clicks and Escape are both refused; only the footer closes it. */
  dismissable?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const el = ref.current;
    if (el && !el.open) el.showModal();
  }, []);

  return (
    <dialog
      ref={ref}
      className={wide ? 'dialog-wide' : undefined}
      aria-labelledby={titleId}
      onClose={onClose}
      onCancel={(e) => {
        // Escape's default action CLOSES the dialog. Handing it a no-op onClose does not stop
        // that — it just means React never learns, so the element stays closed and the effect
        // (deps: []) never reopens it. For a non-dismissable modal that is an invisible page
        // and, for the secret modal, a key destroyed by a keystroke. preventDefault is the
        // only thing that actually refuses Escape.
        if (!dismissable) e.preventDefault();
        else onClose();
      }}
      onClick={(e) => {
        // <dialog> counts backdrop clicks as clicks on the element itself; the inner div
        // stops them, so a target of the dialog means the backdrop.
        if (dismissable && e.target === ref.current) onClose();
      }}
    >
      <div className="dialog-head">
        {icon}
        <h2 className="dialog-title" id={titleId}>
          {title}
        </h2>
      </div>
      {children}
      {footer ? <div className="dialog-foot">{footer}</div> : null}
    </dialog>
  );
}

/**
 * A secret the server will never show again.
 *
 * Deliberately awkward to dismiss: no backdrop-close, no Escape-close, and the acknowledgement
 * checkbox gates the only exit. The value exists solely in this component's props — it was
 * never stored, and closing this drops the last copy. That is worth one extra click.
 */
export function SecretModal({
  title,
  label,
  secret,
  note,
  onClose,
}: {
  title: string;
  label: string;
  secret: string;
  note?: ReactNode;
  onClose: () => void;
}) {
  const [ack, setAck] = useState(false);
  return (
    <Modal
      title={title}
      wide
      dismissable={false}
      icon={<KeyRound size={18} style={{ color: 'var(--warn)' }} />}
      onClose={onClose}
      footer={
        <>
          <label className="check">
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
            I have saved this somewhere safe
          </label>
          <div className="spacer" />
          <button className="btn btn-primary" disabled={!ack} onClick={onClose}>
            Done
          </button>
        </>
      }
    >
      <div className="dialog-body">
        <Alert kind="warn">
          This is shown once and cannot be retrieved later. Copy it now — if you lose it you will have to generate a
          new one.
        </Alert>
        <div className="field">
          <span className="label">{label}</span>
          <div className="secret">
            <code>{secret}</code>
            <CopyButton value={secret} />
          </div>
        </div>
        {note ? <div className="hint">{note}</div> : null}
      </div>
    </Modal>
  );
}

/**
 * Destructive confirmation. `confirmText` turns this into the purge variant: the operator must
 * type the key name back, which is the difference between "are you sure" (a reflex click) and
 * an act that cannot be undone.
 */
export function ConfirmModal({
  title,
  verb = 'Delete',
  danger = true,
  purge = false,
  confirmText,
  busy,
  onConfirm,
  onClose,
  children,
}: {
  title: string;
  verb?: string;
  danger?: boolean;
  purge?: boolean;
  confirmText?: string;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const [typed, setTyped] = useState('');
  const armed = confirmText === undefined || typed === confirmText;

  return (
    <Modal
      title={title}
      icon={<AlertTriangle size={18} style={{ color: danger ? 'var(--danger)' : 'var(--warn)' }} />}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className={`btn ${purge ? 'btn-purge' : danger ? 'btn-danger' : 'btn-primary'}`}
            onClick={onConfirm}
            disabled={busy || !armed}
          >
            {busy ? <Spinner size={14} /> : null}
            {verb}
          </button>
        </>
      }
    >
      <div className="dialog-body">
        {children}
        {confirmText !== undefined ? (
          <div className="field">
            <label className="label" htmlFor="confirm-type">
              Type <code className="mono">{confirmText}</code> to confirm
            </label>
            <input
              id="confirm-type"
              className="input mono"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
            />
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

/** The impact line on a delete: which serials point at the thing being removed. */
export function LinkedSerials({ keys }: { keys: string[] }) {
  if (keys.length === 0) return null;
  return (
    <Alert kind="warn">
      <strong>
        {keys.length} linked serial{keys.length === 1 ? '' : 's'}
      </strong>{' '}
      will be affected:{' '}
      <span className="mono">{keys.join(', ')}</span>
    </Alert>
  );
}

// ---- states ----
export function Spinner({ size = 16 }: { size?: number }) {
  return <Loader2 size={size} className="spin" aria-hidden />;
}

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="state">
      <Spinner size={20} />
      <div className="state-msg">{label}</div>
    </div>
  );
}

export function EmptyState({ title, msg, action }: { title: string; msg?: string; action?: ReactNode }) {
  return (
    <div className="state">
      <Inbox size={24} className="state-icon" aria-hidden />
      <div className="state-title">{title}</div>
      {msg ? <div className="state-msg">{msg}</div> : null}
      {action}
    </div>
  );
}

export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  return (
    <div className="state">
      <AlertTriangle size={24} className="state-icon" aria-hidden />
      <div className="state-title">Could not load this</div>
      <div className="state-msg">{errorMessage(error)}</div>
      {retry ? (
        <button className="btn btn-sm" onClick={retry} type="button">
          Try again
        </button>
      ) : null}
    </div>
  );
}

export function Alert({ kind = 'danger', children }: { kind?: 'danger' | 'warn' | 'info'; children: ReactNode }) {
  const Icon = kind === 'info' ? Info : AlertTriangle;
  return (
    <div className={`alert alert-${kind}`} role={kind === 'danger' ? 'alert' : undefined}>
      <Icon size={14} />
      <div>{children}</div>
    </div>
  );
}

// ---- bits ----
export function RoleBadge({ role }: { role: string }) {
  return <span className={`badge badge-${role === 'owner' ? 'owner' : 'admin'}`}>{role}</span>;
}

export function SearchInput({
  value,
  onChange,
  placeholder = 'Search…',
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="search">
      <Search size={14} />
      <input
        className="input"
        value={value}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

export function Pager({
  total,
  limit,
  offset,
  onOffset,
}: {
  total: number;
  limit: number;
  offset: number;
  onOffset: (n: number) => void;
}) {
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + limit, total);
  return (
    <div className="pager">
      <span>
        {from}–{to} of {total.toLocaleString()}
      </span>
      <div className="row">
        <button className="btn btn-sm" disabled={offset === 0} onClick={() => onOffset(Math.max(0, offset - limit))}>
          Previous
        </button>
        <button className="btn btn-sm" disabled={to >= total} onClick={() => onOffset(offset + limit)}>
          Next
        </button>
      </div>
    </div>
  );
}

/** Copy that degrades honestly: clipboard writes fail under permission policy, and a secret
 *  shown once must never leave the user believing they have it when they do not. */
export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  const toast = useToast();
  return (
    <button
      type="button"
      className="btn btn-sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          toast.error(new Error('Could not copy — select the text and copy it manually.'));
        }
      }}
    >
      {done ? <Check size={13} /> : <Copy size={13} />}
      {done ? 'Copied' : label}
    </button>
  );
}

export function relTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '—';
  const secs = Math.round((Date.now() - then) / 1000);
  const table: [number, Intl.RelativeTimeFormatUnit][] = [
    [60, 'second'],
    [3600, 'minute'],
    [86400, 'hour'],
    [2592000, 'day'],
    [31536000, 'month'],
    [Infinity, 'year'],
  ];
  const fmt = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  let prev = 1;
  for (const [limit, unit] of table) {
    if (Math.abs(secs) < limit) return fmt.format(-Math.round(secs / prev), unit);
    prev = limit;
  }
  return '—';
}

export function absTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleString() : '';
}

/** Relative in the cell, exact on hover — a list is scanned, an incident is investigated. */
export function TimeCell({ iso }: { iso: string | null | undefined }) {
  return <span title={absTime(iso)}>{relTime(iso)}</span>;
}

export function num(n: number | null | undefined): string {
  return n === null || n === undefined ? '—' : n.toLocaleString();
}
