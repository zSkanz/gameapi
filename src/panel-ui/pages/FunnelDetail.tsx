import { useEffect, useState } from 'react';
import { Link, useNavigate, useOutletContext, useParams } from 'react-router-dom';
import { ChevronLeft, Flame, RefreshCw, RotateCcw, Trash2 } from 'lucide-react';
import { api, errorMessage, isApiError, type FunnelRange, type FunnelStep } from '../api';
import { useAuth } from '../auth';
import { useAsync } from '../useAsync';
import { LineChart, MeterCell, type ChartPoint } from '../chart';
import { Alert, ConfirmModal, EmptyState, ErrorState, LoadingState, Spinner, num, relTime, useToast } from '../ui';
import type { GameContext } from './GameDetail';

const RANGES: { id: FunnelRange; label: string }[] = [
  { id: '1h', label: '1 Hour' },
  { id: '1d', label: '1 Day' },
  { id: '7d', label: '7 Days' },
  { id: '30d', label: '30 Days' },
];

/** Day boundaries are cut server-side in whatever zone the person looking is in. */
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

export function FunnelDetail() {
  const { gameId } = useOutletContext<GameContext>();
  const { funnelName = '' } = useParams();
  const { isOwner } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();

  // 7 days, not 30, on purpose: the AVG TIME scan over 30 days is the heaviest query in the
  // panel, and a month should be a click rather than the cost of opening the page.
  const [range, setRange] = useState<FunnelRange>('7d');
  const [action, setAction] = useState<'delete' | 'purge' | null>(null);
  const [loadedAt, setLoadedAt] = useState(() => new Date().toISOString());

  const report = useAsync(
    (signal) => api.getFunnel(gameId, funnelName, { range, tz: TZ }, signal),
    [gameId, funnelName, range],
  );

  useEffect(() => {
    if (report.data) setLoadedAt(new Date().toISOString());
  }, [report.data]);

  // Re-render the "loaded N ago" label on a timer. This is NOT polling — nothing is fetched;
  // without it the label would be frozen at the string it was born with, which is a lie.
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  async function restore() {
    try {
      await api.restoreFunnel(gameId, funnelName);
      toast.success(`Restored ${funnelName}.`);
      report.reload();
    } catch (err) {
      toast.error(err);
    }
  }

  const d = report.data;

  if (report.loading && !d) return <LoadingState label="Loading funnel…" />;

  if (report.error && !d) {
    return isApiError(report.error, 'FUNNEL_NOT_FOUND') ? (
      <EmptyState
        title="No such funnel"
        msg={`Nothing named "${funnelName}" on this game. It may have been purged, or the name may be misspelled.`}
        action={
          <Link className="btn btn-sm" to="..">
            Back to funnels
          </Link>
        }
      />
    ) : (
      <ErrorState error={report.error} retry={report.reload} />
    );
  }

  if (!d) return <ErrorState error={report.error} retry={report.reload} />;

  const points: ChartPoint[] = d.buckets.map((b) => ({
    label: bucketLabel(b.at, range),
    title: new Date(b.at).toLocaleString(),
    value: b.entrants === 0 ? 0 : b.completed / b.entrants,
    entrants: b.entrants,
    completed: b.completed,
    partial: b.partial,
  }));

  const deleted = !!d.deletedAt;

  return (
    <div className="stack">
      <div className="row row-wrap">
        <Link to=".." className="btn btn-ghost btn-sm" style={{ marginLeft: 'calc(var(--sp-2) * -1)' }}>
          <ChevronLeft size={14} />
          Funnels
        </Link>
        <span className="cell-strong">{d.displayName || d.funnelName}</span>
        <span className={`badge badge-${d.kind === 'onboarding' ? 'owner' : 'admin'}`}>{d.kind}</span>
        {deleted ? <span className="badge badge-danger">deleted</span> : null}

        <div className="spacer" />

        {/* One filter row, above everything it scopes: tiles, chart and table all re-render
            against the same window, so the numbers can never disagree with each other. */}
        <div className="seg" role="group" aria-label="Time range">
          {RANGES.map((r) => (
            <button
              key={r.id}
              type="button"
              className="seg-btn"
              aria-pressed={range === r.id}
              disabled={report.loading}
              onClick={() => setRange(r.id)}
            >
              {r.label}
            </button>
          ))}
        </div>

        <button className="btn btn-sm" onClick={report.reload} disabled={report.loading}>
          {report.loading ? <Spinner size={13} /> : <RefreshCw size={13} />}
          Refresh
        </button>
        <span className="hint" style={{ whiteSpace: 'nowrap' }}>
          loaded {relTime(loadedAt)}
        </span>

        {isOwner ? (
          <>
            {deleted ? (
              <button className="btn btn-sm" onClick={() => void restore()}>
                <RotateCcw size={13} />
                Restore
              </button>
            ) : (
              <button className="btn btn-sm" style={{ color: 'var(--danger)' }} onClick={() => setAction('delete')}>
                <Trash2 size={13} />
                Delete
              </button>
            )}
            <button className="btn btn-sm" style={{ color: 'var(--danger)' }} onClick={() => setAction('purge')}>
              <Flame size={13} />
              Purge
            </button>
          </>
        ) : null}
      </div>

      {/* Refetch holds the previous render at reduced opacity — no skeleton flash, no jump. */}
      <div className="stack" style={{ opacity: report.loading ? 0.55 : 1 }}>
        <div className="stats">
          <div className="stat">
            <div className="stat-label">Total players started</div>
            <div className="stat-value">{num(d.entrants)}</div>
          </div>
          <div className="stat">
            <div className="stat-label">Completed all steps</div>
            <div className="stat-value">{num(d.completed)}</div>
          </div>
          <div className="stat">
            <div className="stat-label">Overall completion</div>
            <div className="stat-value" style={{ color: 'var(--success)' }}>
              {pct(d.completionRate)}
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <span className="card-title">Completion rate over time</span>
            <div className="spacer" />
            <span className="hint">{d.stepCount} steps</span>
          </div>
          <div className="card-body">
            <LineChart points={points} />
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <span className="card-title">Steps</span>
          </div>
          {d.steps.length === 0 ? (
            <EmptyState title="No steps in this range" msg="Nothing was logged for this funnel in the window above." />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th className="num">Step</th>
                    <th>Name</th>
                    <th className="num">Players</th>
                    <th>Completion rate</th>
                    <th className="num">Churn rate</th>
                    <th className="num">Avg time</th>
                  </tr>
                </thead>
                <tbody>
                  {d.steps.map((s) => (
                    <StepRow key={s.step} step={s} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {action === 'delete' ? (
        <DeleteFunnelDialog
          gameId={gameId}
          funnelName={funnelName}
          onClose={() => setAction(null)}
          onDone={() => navigate('..')}
        />
      ) : null}
      {action === 'purge' ? (
        <PurgeFunnelDialog
          gameId={gameId}
          funnelName={funnelName}
          onClose={() => setAction(null)}
          onDone={() => navigate('..')}
        />
      ) : null}
    </div>
  );
}

function StepRow({ step }: { step: FunnelStep }) {
  return (
    <tr>
      <td className="num">{step.step}</td>
      <td>{step.name || <span style={{ color: 'var(--fg-subtle)' }}>—</span>}</td>
      <td className="num">{num(step.players)}</td>
      <td>
        <MeterCell value={step.completionRate} />
      </td>
      {/* Step 1 has no previous step, so churn and the gap to it are not "0" — they do not
          exist. A dash says that; a zero would be a claim. */}
      <td className="num">{step.churnRate === null ? '—' : pct(step.churnRate)}</td>
      <td className="num" title={`${step.samples.toLocaleString()} samples`}>
        {step.avgMs === null ? '—' : duration(step.avgMs)}
      </td>
    </tr>
  );
}

function DeleteFunnelDialog({
  gameId,
  funnelName,
  onClose,
  onDone,
}: {
  gameId: string;
  funnelName: string;
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
      await api.deleteFunnel(gameId, funnelName);
      toast.success(`Deleted ${funnelName}.`);
      onDone();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <ConfirmModal title={`Delete ${funnelName}?`} verb="Delete" busy={busy} onConfirm={() => void confirm()} onClose={onClose}>
      {error ? <Alert>{errorMessage(error)}</Alert> : null}
      <p>
        This is a soft delete and can be undone here. The events already recorded are kept, but the game's log calls
        for this funnel are <strong>dropped</strong> from now on rather than re-creating it.
      </p>
    </ConfirmModal>
  );
}

function PurgeFunnelDialog({
  gameId,
  funnelName,
  onClose,
  onDone,
}: {
  gameId: string;
  funnelName: string;
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
      // No Idempotency-Key: a hard delete replayed is a no-op by construction.
      const res = await api.purgeFunnel(gameId, funnelName, funnelName);
      toast.success(
        `Purged ${funnelName}. ${res.eventsDeleted.toLocaleString()} events and ` +
          `${res.runsDeleted.toLocaleString()} runs deleted.`,
      );
      onDone();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <ConfirmModal
      title={`Purge ${funnelName}`}
      verb="Purge permanently"
      purge
      confirmText={funnelName}
      busy={busy}
      onConfirm={() => void confirm()}
      onClose={onClose}
    >
      {error ? <Alert>{errorMessage(error)}</Alert> : null}
      <Alert>
        <strong>This cannot be undone.</strong> Unlike delete, purge destroys the funnel, its step names and every
        event and run recorded against it. There is no restore, and the history cannot be rebuilt.
      </Alert>
    </ConfirmModal>
  );
}

/** 0..1 fraction to a percentage. The API never sends percentages; formatting lives here. */
function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

function duration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.round((ms % 60_000) / 1000);
  if (mins < 60) return `${mins}m ${secs}s`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function bucketLabel(iso: string, range: FunnelRange): string {
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return '—';
  return range === '1h' || range === '1d'
    ? at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
