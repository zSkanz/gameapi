import type { Pool } from 'pg';
import { Errors } from '../../core/errors/app-error';
import {
  FUNNEL_MAX_BACKDATE_MS,
  MAX_CUSTOM_FUNNELS,
  ONBOARDING_FUNNEL,
} from '../../core/constants';
import { funnelEvents } from '../../core/metrics';
import type { FunnelEventInput, LogBatch } from './funnel.schemas';

export interface IngestResult {
  funnelName: string;
  accepted: number;
  duplicates: number;
  dropped: number;
  runsTouched: number;
}

export interface FunnelListItem {
  funnelName: string;
  kind: string;
  displayName: string | null;
  stepCount: number;
  lastEventAt: string | null;
  deletedAt: string | null;
}

/** One row of the per-step table. `churn`/`avgMs` are null on step 1 — it has no predecessor. */
export interface StepRow {
  step: number;
  name: string;
  players: number;
  completionRate: number;
  churnRate: number | null;
  avgMs: number | null;
  samples: number;
}

export interface Bucket {
  at: string;
  entrants: number;
  completed: number;
  /** The cohort has not had time to finish yet — the UI dashes these instead of hiding them. */
  partial: boolean;
}

export interface Dashboard {
  funnelName: string;
  kind: string;
  displayName: string | null;
  stepCount: number;
  entrants: number;
  completed: number;
  completionRate: number;
  steps: StepRow[];
  buckets: Bucket[];
  lastEventAt: string | null;
  /** Set = deleted. The detail page needs it to offer Restore instead of Delete. */
  deletedAt: string | null;
}

export type Range = '1h' | '1d' | '7d' | '30d';

/** Range -> window length and chart bucket width. Four rows, no knob. */
const RANGES: Record<Range, { ms: number; bucket: string; label: string }> = {
  '1h': { ms: 3_600_000, bucket: '5 minutes', label: '5m' },
  '1d': { ms: 86_400_000, bucket: '1 hour', label: '1h' },
  '7d': { ms: 604_800_000, bucket: '6 hours', label: '6h' },
  '30d': { ms: 2_592_000_000, bucket: '1 day', label: '1d' },
};

/**
 * Distinct from MIGRATION_LOCK_ID (core/db/migrate.ts). Advisory lock ids share one global
 * namespace, so a collision would let a retention sweep block a deploy.
 */
const FUNNEL_SWEEP_LOCK_ID = 4_820_116;
const SWEEP_BATCH = 5000;

/**
 * funnel.last_event_at is written at most this often per funnel. It only drives "last event 3s ago"
 * in the panel, and writing it on every batch put every server's batch on one row lock.
 */
const LAST_EVENT_RESOLUTION_S = 10;

/**
 * The only layer that touches Postgres for funnels.
 *
 * Two write statements per batch (plus two lock-free reads that usually make them one) and no
 * transaction: each is individually atomic and individually idempotent (the event insert is ON
 * CONFLICT DO NOTHING; every maintained column on funnel_run is GREATEST/LEAST), so a wrapping tx
 * would buy nothing and cost two round trips. A funnel row created without events is harmless.
 */
export class FunnelRepository {
  constructor(private readonly pg: Pool) {}

  // ================================================================ ingest

  async ingest(gameId: string, batch: LogBatch, keyId: string): Promise<IngestResult> {
    const isOnboarding = batch.kind === 'onboarding';
    const funnelName = isOnboarding ? ONBOARDING_FUNNEL : batch.funnelName;

    // Roblox gives the onboarding funnel no name of its own, so the name is reserved. A custom
    // funnel claiming it would silently merge two different things into one chart.
    if (!isOnboarding && funnelName === ONBOARDING_FUNNEL) {
      throw Errors.conflict(
        `"${ONBOARDING_FUNNEL}" is reserved for the onboarding funnel. Use kind:"onboarding" or another name.`,
        { gameId, funnelName },
      );
    }

    const stepCount = Math.max(batch.steps?.length ?? 0, ...batch.events.map((e) => e.step));

    // --- statement 1: funnel get-or-create ---------------------------------
    // Every server's batch lands on this one row. Read it first, without a lock: in the steady
    // state nothing about it changes, and the upsert below would still lock and rewrite it
    // (ON CONFLICT DO UPDATE locks even when nothing changes) for every batch from every server.
    // The read is fresh, so a delete is honoured exactly as before; only last_event_at gets coarser.
    const seen = await this.pg.query(
      `SELECT step_count, deleted_at FROM funnel
       WHERE game_id = $1 AND funnel_name = $2
         AND step_count >= $3
         AND ($4::text IS NULL OR display_name IS NOT DISTINCT FROM $4)
         AND last_event_at > now() - $5::interval`,
      [gameId, funnelName, stepCount, batch.displayName ?? null, `${LAST_EVENT_RESOLUTION_S} seconds`],
    );
    // DO UPDATE rather than DO NOTHING so RETURNING always yields a row: DO NOTHING returns
    // nothing on conflict and would force a second SELECT just to read deleted_at.
    const f = seen.rows[0] ? seen : await this.pg.query(
      `INSERT INTO funnel (game_id, funnel_name, kind, display_name, step_count, last_event_at, created_by)
       VALUES ($1, $2, $3, $4, $5, now(), $6)
       ON CONFLICT (game_id, funnel_name) DO UPDATE
         SET step_count    = GREATEST(funnel.step_count, EXCLUDED.step_count),
             display_name  = COALESCE(EXCLUDED.display_name, funnel.display_name),
             last_event_at = now(),
             updated_at    = now()
       RETURNING step_count, deleted_at, (xmax = 0) AS inserted`,
      [gameId, funnelName, batch.kind, batch.displayName ?? null, stepCount, keyId],
    );
    const row = f.rows[0];

    // A deleted funnel drops its events instead of un-deleting itself — the deliberate divergence
    // from stock's /get. 200, not 4xx: a 4xx would make the Lua retry loop spin forever.
    if (row.deleted_at) {
      funnelEvents.labels('dropped').inc(batch.events.length);
      return { funnelName, accepted: 0, duplicates: 0, dropped: batch.events.length, runsTouched: 0 };
    }

    // Roblox caps an experience at 10 custom funnels. Checked only when we just created one, so
    // the steady-state ingest path never pays for this count.
    if (row.inserted && !isOnboarding) {
      const n = await this.pg.query(
        `SELECT count(*)::int AS n FROM funnel
         WHERE game_id = $1 AND kind = 'custom' AND deleted_at IS NULL`,
        [gameId],
      );
      if (Number(n.rows[0].n) > MAX_CUSTOM_FUNNELS) {
        await this.pg.query(`DELETE FROM funnel WHERE game_id = $1 AND funnel_name = $2`, [gameId, funnelName]);
        throw Errors.conflict(
          `This game already has its maximum of ${MAX_CUSTOM_FUNNELS} custom funnels — the same limit Roblox applies.`,
          { gameId, maxFunnels: MAX_CUSTOM_FUNNELS },
        );
      }
    }

    // --- statement 1b: step names ------------------------------------------
    // The batch's `steps` array is authoritative, but an event may also carry its own stepName
    // (Roblox's API shape). Fold those in for any step the array does not cover, so a client that
    // only names steps per event still gets a readable dashboard.
    const names = new Map<number, string>();
    for (const e of batch.events) if (e.stepName) names.set(e.step, e.stepName);
    batch.steps?.forEach((name, i) => names.set(i + 1, name));

    if (names.size > 0) {
      // Same idea as statement 1: the names are almost always already stored, and the upsert
      // locks every row it touches even when its WHERE skips the update. Write only the ones
      // that differ.
      const stored = await this.pg.query(`SELECT step, step_name FROM funnel_step WHERE game_id = $1 AND funnel_name = $2`, [
        gameId,
        funnelName,
      ]);
      for (const row of stored.rows) if (names.get(Number(row.step)) === row.step_name) names.delete(Number(row.step));
    }

    if (names.size > 0) {
      // Sorted by step: two batches locking the same step rows in different orders deadlock.
      const steps = [...names.keys()].sort((a, b) => a - b);
      await this.pg.query(
        `INSERT INTO funnel_step (game_id, funnel_name, step, step_name)
         SELECT $1, $2, i.step, i.step_name
         FROM unnest($3::int[], $4::text[]) AS i(step, step_name)
         ON CONFLICT (game_id, funnel_name, step) DO UPDATE
           SET step_name = EXCLUDED.step_name, updated_at = now()
           WHERE funnel_step.step_name IS DISTINCT FROM EXCLUDED.step_name`,
        [gameId, funnelName, steps, steps.map((n) => names.get(n)!)],
      );
    }

    // --- statement 2: events + runs, one statement -------------------------
    const cols = columnsOf(batch.events);
    const r = await this.pg.query(
      `WITH input AS (
         SELECT i.player_id,
                COALESCE(i.session_id, '') AS session_id,
                i.step,
                -- Clamped HERE, in SQL, not in Node: the read-side range filter uses Postgres'
                -- clock, so clamping against Node's would let container drift silently drop
                -- events out of the newest chart bucket — which looks exactly like the
                -- right-censoring the chart already has, so nobody would ever notice.
                LEAST(now(), GREATEST(
                  COALESCE(to_timestamp(i.at_epoch), now()),
                  now() - $9::interval
                )) AS occurred_at,
                LEAST(i.ms_since_prev, $10::int) AS ms_since_prev,
                i.cf1, i.cf2, i.cf3
         FROM unnest($3::bigint[], $4::text[], $5::int[], $6::double precision[], $7::int[],
                     $8::text[], $11::text[], $12::text[])
                AS i(player_id, session_id, step, at_epoch, ms_since_prev, cf1, cf2, cf3)
       ),
       ins AS (
         INSERT INTO funnel_event
               (game_id, funnel_name, player_id, session_id, step, occurred_at, ms_since_prev)
         SELECT $1, $2, player_id, session_id, step, occurred_at, ms_since_prev FROM input
         ON CONFLICT (game_id, funnel_name, player_id, session_id, step) DO NOTHING
         RETURNING player_id, session_id, step, occurred_at
       ),
       runs AS (
         -- THE GROUP BY IS NOT OPTIONAL. Without it a batch carrying two steps for the same run —
         -- a server flushing step 2 and step 3 together, which is the COMMON case — raises
         -- 21000 "ON CONFLICT DO UPDATE command cannot affect row a second time" and 500s.
         SELECT i.player_id, i.session_id,
                min(i.occurred_at) AS started_at,
                max(i.step)        AS max_step,
                max(i.occurred_at) AS last_step_at,
                max(i.cf1)         AS cf1,
                max(i.cf2)         AS cf2,
                max(i.cf3)         AS cf3
         FROM ins x
         JOIN input i ON i.player_id = x.player_id AND i.session_id = x.session_id AND i.step = x.step
         GROUP BY i.player_id, i.session_id
       ),
       upd AS (
         INSERT INTO funnel_run
               (game_id, funnel_name, player_id, session_id, started_at, max_step, last_step_at, cf1, cf2, cf3)
         SELECT $1, $2, player_id, session_id, started_at, max_step, last_step_at, cf1, cf2, cf3 FROM runs
         ON CONFLICT (game_id, funnel_name, player_id, session_id) DO UPDATE
           -- Monotonic only. A counter here would look harmless and double-count on every retry.
           SET started_at   = LEAST   (funnel_run.started_at,   EXCLUDED.started_at),
               max_step     = GREATEST(funnel_run.max_step,     EXCLUDED.max_step),
               last_step_at = GREATEST(funnel_run.last_step_at, EXCLUDED.last_step_at),
               cf1          = COALESCE(EXCLUDED.cf1, funnel_run.cf1),
               cf2          = COALESCE(EXCLUDED.cf2, funnel_run.cf2),
               cf3          = COALESCE(EXCLUDED.cf3, funnel_run.cf3)
         RETURNING 1
       )
       SELECT (SELECT count(*) FROM ins)::int AS accepted,
              (SELECT count(*) FROM upd)::int AS runs_touched`,
      [
        gameId,
        funnelName,
        cols.playerIds,
        cols.sessionIds,
        cols.steps,
        cols.ats,
        cols.msSincePrev,
        cols.cf1,
        `${FUNNEL_MAX_BACKDATE_MS} milliseconds`,
        FUNNEL_MAX_BACKDATE_MS,
        cols.cf2,
        cols.cf3,
      ],
    );

    const accepted = Number(r.rows[0].accepted);
    const duplicates = batch.events.length - accepted;
    funnelEvents.labels('accepted').inc(accepted);
    if (duplicates > 0) funnelEvents.labels('duplicate').inc(duplicates);

    return {
      funnelName,
      accepted,
      duplicates,
      dropped: 0,
      runsTouched: Number(r.rows[0].runs_touched),
    };
  }

  // ================================================================ reads

  async list(gameId: string, includeDeleted = false): Promise<FunnelListItem[]> {
    const r = await this.pg.query(
      `SELECT funnel_name, kind, display_name, step_count, last_event_at, deleted_at
       FROM funnel
       WHERE game_id = $1 AND ($2::boolean OR deleted_at IS NULL)
       ORDER BY (kind = 'onboarding') DESC, funnel_name`,
      [gameId, includeDeleted],
    );
    return r.rows.map((row) => ({
      funnelName: row.funnel_name as string,
      kind: row.kind as string,
      displayName: (row.display_name as string | null) ?? null,
      stepCount: Number(row.step_count),
      lastEventAt: row.last_event_at ? (row.last_event_at as Date).toISOString() : null,
      deletedAt: row.deleted_at ? (row.deleted_at as Date).toISOString() : null,
    }));
  }

  /**
   * The whole dashboard. Three independent single-table scans, no join between the fact table and
   * the run table anywhere — that separation is what keeps this under statement_timeout.
   */
  async dashboard(
    gameId: string,
    funnelName: string,
    range: Range,
    tz: string,
    filters: { cf1?: string; cf2?: string; cf3?: string } = {},
  ): Promise<Dashboard> {
    // Deliberately NOT filtered on deleted_at, same as GET /panel/games/:gameId: the panel has to
    // be able to open a deleted funnel to restore it. Its history is all still there — deleting
    // only stops ingest — so the dashboard renders normally with a "deleted" banner over it.
    const meta = await this.pg.query(
      `SELECT funnel_name, kind, display_name, step_count, last_event_at, deleted_at
       FROM funnel WHERE game_id = $1 AND funnel_name = $2`,
      [gameId, funnelName],
    );
    if (meta.rowCount === 0) throw Errors.funnelNotFound(gameId, funnelName);
    const m = meta.rows[0];
    const stepCount = Number(m.step_count);

    const { ms, bucket } = RANGES[range];
    const from = new Date(Date.now() - ms);
    const cf = [filters.cf1 ?? null, filters.cf2 ?? null, filters.cf3 ?? null];

    const [hist, series, names] = await Promise.all([
      // Cohort histogram + the p90 completion time, one scan of funnel_run_cohort_idx.
      this.pg.query(
        `SELECT max_step, count(*)::int AS n,
                percentile_disc(0.9) WITHIN GROUP (
                  ORDER BY EXTRACT(EPOCH FROM (last_step_at - started_at))
                ) FILTER (WHERE max_step >= $4) AS p90_seconds
         FROM funnel_run
         WHERE game_id = $1 AND funnel_name = $2 AND started_at >= $3
           AND ($5::text IS NULL OR cf1 = $5)
           AND ($6::text IS NULL OR cf2 = $6)
           AND ($7::text IS NULL OR cf3 = $7)
         GROUP BY max_step`,
        [gameId, funnelName, from, Math.max(stepCount, 1), ...cf],
      ),
      // The chart. generate_series LEFT JOIN fills empty buckets with zeros so the line is
      // continuous; date_bin's origin is the range start, so the rightmost point ends at now().
      this.pg.query(
        `SELECT b.bucket,
                COALESCE(g.entrants, 0)::int  AS entrants,
                COALESCE(g.completed, 0)::int AS completed
         FROM generate_series($3::timestamptz, now(), $4::interval) AS b(bucket)
         LEFT JOIN (
           SELECT date_bin($4::interval, r.started_at AT TIME ZONE $8, $3::timestamptz AT TIME ZONE $8) AS bucket,
                  count(*)::int                                  AS entrants,
                  count(*) FILTER (WHERE r.max_step >= $5)::int   AS completed
           FROM funnel_run r
           WHERE r.game_id = $1 AND r.funnel_name = $2 AND r.started_at >= $3
             AND ($6::text IS NULL OR r.cf1 = $6)
             AND ($7::text IS NULL OR r.cf2 = $7)
             AND ($9::text IS NULL OR r.cf3 = $9)
           GROUP BY 1
         ) g ON g.bucket = b.bucket AT TIME ZONE $8
         ORDER BY b.bucket`,
        [gameId, funnelName, from, bucket, Math.max(stepCount, 1), cf[0], cf[1], tz, cf[2]],
      ),
      this.pg.query(
        `SELECT s.step, s.step_name,
                t.avg_ms, t.samples
         FROM funnel_step s
         LEFT JOIN (
           SELECT step, avg(ms_since_prev)::bigint AS avg_ms, count(ms_since_prev)::int AS samples
           FROM funnel_event
           WHERE game_id = $1 AND funnel_name = $2 AND occurred_at >= $3 AND step > 1
           GROUP BY step
         ) t ON t.step = s.step
         WHERE s.game_id = $1 AND s.funnel_name = $2
         ORDER BY s.step`,
        [gameId, funnelName, from],
      ),
    ]);

    // players[N] = runs with max_step >= N. Monotonic by construction, which is the whole reason
    // funnel_run exists — churn can never come out negative.
    const byMax = new Map<number, number>(hist.rows.map((h) => [Number(h.max_step), Number(h.n)]));
    const players: number[] = [];
    for (let step = 1; step <= stepCount; step++) {
      let n = 0;
      for (const [maxStep, count] of byMax) if (maxStep >= step) n += count;
      players.push(n);
    }

    const nameOf = new Map<number, string>(names.rows.map((n) => [Number(n.step), n.step_name as string]));
    const timing = new Map<number, { avgMs: number | null; samples: number }>(
      names.rows.map((n) => [
        Number(n.step),
        { avgMs: n.avg_ms === null ? null : Number(n.avg_ms), samples: Number(n.samples ?? 0) },
      ]),
    );

    const entrants = players[0] ?? 0;
    const steps: StepRow[] = players.map((count, i) => {
      const step = i + 1;
      const prev = i === 0 ? null : (players[i - 1] ?? 0);
      const t = timing.get(step);
      return {
        step,
        name: nameOf.get(step) ?? `Step ${step}`,
        players: count,
        completionRate: entrants === 0 ? 0 : count / entrants,
        // Step 1 has no predecessor, and a zero-population predecessor has no rate — both render "—".
        churnRate: prev === null || prev === 0 ? null : (prev - count) / prev,
        avgMs: t?.avgMs ?? null,
        samples: t?.samples ?? 0,
      };
    });

    // Right-censoring, shown rather than hidden: a bucket newer than the p90 completion time is
    // still filling, so its rate is not comparable to a settled one.
    const p90 = Number(hist.rows.find((h) => h.p90_seconds !== null)?.p90_seconds ?? 0);
    const settledBefore = Date.now() - p90 * 1000;
    const buckets: Bucket[] = series.rows.map((b) => {
      const at = b.bucket as Date;
      return {
        at: at.toISOString(),
        entrants: Number(b.entrants),
        completed: Number(b.completed),
        partial: at.getTime() > settledBefore,
      };
    });

    const completed = players[stepCount - 1] ?? 0;
    return {
      funnelName: m.funnel_name as string,
      kind: m.kind as string,
      displayName: (m.display_name as string | null) ?? null,
      stepCount,
      entrants,
      completed,
      completionRate: entrants === 0 ? 0 : completed / entrants,
      steps,
      buckets,
      lastEventAt: m.last_event_at ? (m.last_event_at as Date).toISOString() : null,
      deletedAt: m.deleted_at ? (m.deleted_at as Date).toISOString() : null,
    };
  }

  // ================================================================ panel mutations

  async rename(gameId: string, funnelName: string, displayName: string | null): Promise<FunnelListItem> {
    const r = await this.pg.query(
      `UPDATE funnel SET display_name = $3, updated_at = now()
       WHERE game_id = $1 AND funnel_name = $2 AND deleted_at IS NULL
       RETURNING funnel_name, kind, display_name, step_count, last_event_at, deleted_at`,
      [gameId, funnelName, displayName],
    );
    if (r.rowCount === 0) throw Errors.funnelNotFound(gameId, funnelName);
    const row = r.rows[0];
    return {
      funnelName: row.funnel_name as string,
      kind: row.kind as string,
      displayName: (row.display_name as string | null) ?? null,
      stepCount: Number(row.step_count),
      lastEventAt: row.last_event_at ? (row.last_event_at as Date).toISOString() : null,
      deletedAt: null,
    };
  }

  async softDelete(gameId: string, funnelName: string, actorId: string): Promise<{ deletedAt: string }> {
    const r = await this.pg.query(
      `UPDATE funnel SET deleted_at = now(), deleted_by = $3, updated_at = now()
       WHERE game_id = $1 AND funnel_name = $2 AND deleted_at IS NULL
       RETURNING deleted_at`,
      [gameId, funnelName, actorId],
    );
    if (r.rowCount === 0) throw Errors.funnelNotFound(gameId, funnelName);
    return { deletedAt: (r.rows[0].deleted_at as Date).toISOString() };
  }

  async restore(gameId: string, funnelName: string): Promise<{ restored: true }> {
    const r = await this.pg.query(
      `UPDATE funnel SET deleted_at = NULL, deleted_by = NULL, updated_at = now()
       WHERE game_id = $1 AND funnel_name = $2 AND deleted_at IS NOT NULL
       RETURNING funnel_name`,
      [gameId, funnelName],
    );
    if (r.rowCount === 0) {
      // 404-then-409 probe, same shape as stock/serial restore.
      const ex = await this.pg.query(`SELECT 1 FROM funnel WHERE game_id = $1 AND funnel_name = $2`, [
        gameId,
        funnelName,
      ]);
      if (ex.rowCount === 0) throw Errors.funnelNotFound(gameId, funnelName);
      throw Errors.conflict('That funnel is not deleted.', { gameId, funnelName });
    }
    return { restored: true };
  }

  /** Owner-only, irreversible. Requires a prior soft delete — the safeguard, same as stock. */
  async purge(gameId: string, funnelName: string): Promise<{ eventsDeleted: number; runsDeleted: number }> {
    const del = await this.pg.query(
      `DELETE FROM funnel WHERE game_id = $1 AND funnel_name = $2 AND deleted_at IS NOT NULL
       RETURNING funnel_name`,
      [gameId, funnelName],
    );
    if (del.rowCount === 0) {
      const ex = await this.pg.query(`SELECT 1 FROM funnel WHERE game_id = $1 AND funnel_name = $2`, [
        gameId,
        funnelName,
      ]);
      if (ex.rowCount === 0) throw Errors.funnelNotFound(gameId, funnelName);
      throw Errors.conflict('Delete the funnel before purging it.', { gameId, funnelName });
    }
    // funnel_step cascades; the fact tables have no FK on purpose, so they drain here.
    const eventsDeleted = await this.drain('funnel_event', gameId, funnelName, null);
    const runsDeleted = await this.drain('funnel_run', gameId, funnelName, null);
    return { eventsDeleted, runsDeleted };
  }

  // ================================================================ retention

  /**
   * Delete events past the retention horizon.
   *
   * pg_TRY_advisory_lock, not pg_advisory_lock: the blocking one in core/db/migrate.ts is right
   * there (a deployer must wait) and wrong here — N-1 replicas would pile up on the lock every
   * hour. The loser returns immediately.
   */
  async sweep(retentionDays: number): Promise<{ eventsDeleted: number; runsDeleted: number }> {
    if (retentionDays <= 0) return { eventsDeleted: 0, runsDeleted: 0 };

    // MUST be connect(), not query(): advisory locks are SESSION-scoped, and a pooled query would
    // take the lock on one connection and release it on another.
    const client = await this.pg.connect();
    let held = false;
    try {
      const got = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [FUNNEL_SWEEP_LOCK_ID]);
      if (!got.rows[0].ok) return { eventsDeleted: 0, runsDeleted: 0 }; // another replica has it
      held = true;

      // One day of grace beyond the retention window, or the oldest bucket of the 30-day view
      // renders truncated.
      const cutoffDays = retentionDays + 1;
      const funnels = await client.query(`SELECT game_id, funnel_name FROM funnel`);

      let eventsDeleted = 0;
      let runsDeleted = 0;
      for (const f of funnels.rows) {
        eventsDeleted += await this.drain('funnel_event', f.game_id, f.funnel_name, cutoffDays);
        runsDeleted += await this.drain('funnel_run', f.game_id, f.funnel_name, cutoffDays);
      }
      return { eventsDeleted, runsDeleted };
    } finally {
      if (held) {
        await client.query('SELECT pg_advisory_unlock($1)', [FUNNEL_SWEEP_LOCK_ID]).catch(() => {});
      }
      client.release();
    }
  }

  /**
   * Batched ctid delete — the same loop as stock's purge and for the same reason: statement_timeout
   * is 5s, and an unbounded DELETE on a busy funnel raises 57014, which would make the only remedy
   * unusable. Each batch runs on the pool (autocommit), so the timeout applies per batch and not
   * to the whole sweep.
   */
  private async drain(
    table: 'funnel_event' | 'funnel_run',
    gameId: string,
    funnelName: string,
    olderThanDays: number | null,
  ): Promise<number> {
    const timeCol = table === 'funnel_event' ? 'occurred_at' : 'started_at';
    const cutoff = olderThanDays === null ? '' : `AND ${timeCol} < now() - ($3::int * INTERVAL '1 day')`;
    const params = olderThanDays === null ? [gameId, funnelName] : [gameId, funnelName, olderThanDays];

    let total = 0;
    for (;;) {
      const r = await this.pg.query(
        `DELETE FROM ${table} WHERE ctid IN (
           SELECT ctid FROM ${table}
           WHERE game_id = $1 AND funnel_name = $2 ${cutoff}
           LIMIT ${SWEEP_BATCH}
         )`,
        params,
      );
      const n = r.rowCount ?? 0;
      total += n;
      if (n < SWEEP_BATCH) break;
    }
    return total;
  }
}

/** Flatten a batch into the parallel arrays the ingest statement unnests. */
function columnsOf(events: FunnelEventInput[]) {
  return {
    playerIds: events.map((e) => e.playerId),
    sessionIds: events.map((e) => e.sessionId ?? ''),
    steps: events.map((e) => e.step),
    ats: events.map((e) => e.at ?? null),
    msSincePrev: events.map((e) => e.msSincePrev ?? null),
    cf1: events.map((e) => e.customFields?.CustomField01 ?? null),
    cf2: events.map((e) => e.customFields?.CustomField02 ?? null),
    cf3: events.map((e) => e.customFields?.CustomField03 ?? null),
  };
}
