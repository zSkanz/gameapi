-- Funnel analytics. Roblox servers log "player X reached step N of funnel F"; the panel renders
-- entrants, completion, churn and per-step timings over a time range.
--
-- Mirrors Roblox's own AnalyticsService API deliberately, so game code calls our client the same
-- way it calls theirs (create.roblox.com/docs/production/analytics/funnel-events):
--   LogOnboardingFunnelStepEvent(player, step, stepName?, customFields?)   -- one per experience
--   LogFunnelStepEvent(player, funnelName, funnelSessionId?, step, ...)     -- max 10, repeatable
-- Their limits are our limits: steps 1-100, 10 custom funnels per game, three custom fields.
--
-- This is the first UNBOUNDED table in the schema. The stock and serial ledgers grow with
-- purchases, which are bounded by stock; funnel_event grows with player-seconds — ~350k rows/week
-- for a funnel the size of the one this was designed against (~62k entrants, 6 steps). Two
-- consequences are baked in below: the event row is as narrow as it can be, and the dashboard's
-- three headline numbers NEVER scan it.

-- ---------------------------------------------------------------- funnel
-- Auto-created on first log, exactly like stock's /get and serial's /get: a funnel is never
-- declared anywhere, the first event that names it brings it into existence.
CREATE TABLE IF NOT EXISTS funnel (
  game_id       TEXT NOT NULL REFERENCES game(game_id),
  funnel_name   TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'custom' CHECK (kind IN ('onboarding','custom')),
  display_name  TEXT,                                  -- NULL = show funnel_name
  step_count    INT  NOT NULL DEFAULT 0 CHECK (step_count >= 0 AND step_count <= 100),
  last_event_at TIMESTAMPTZ,                           -- powers "last seen 3s ago" in the panel
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ,                           -- soft delete, same as stock/serial/game
  deleted_by    TEXT,                                  -- 'panel:<userId>'
  PRIMARY KEY (game_id, funnel_name)
);

COMMENT ON COLUMN funnel.kind IS
  'Mirrors Roblox''s split. ''onboarding'' is the ONE funnel per experience that has no name of its
   own (LogOnboardingFunnelStepEvent takes no funnelName), so it occupies the reserved funnel_name
   ''onboarding'' and the ingest route refuses that name from the custom-funnel path. ''custom'' is
   capped at 10 per game, the same as Roblox — enforced in the repository, not here, because a
   CHECK cannot count sibling rows.';

COMMENT ON COLUMN funnel.step_count IS
  'How many steps this funnel has, i.e. what COMPLETED ALL STEPS means. Maintained as
   GREATEST(old, new) on ingest: monotonic, so a replayed batch is a no-op and a client that
   flushes a short batch cannot shrink the funnel. The consequence is deliberate and the panel
   surfaces it: ADDING a 7th step retroactively makes every past 6-step completer incomplete. That
   is not a bug — the funnel changed, so its history did — but it looks like a cliff on the chart.
   Only a panel action can lower it.';

COMMENT ON COLUMN funnel.deleted_at IS
  'Soft delete, and unlike stock this one is a REAL off switch: ingest already upserts this row
   once per batch for get-or-create, so reading deleted_at there is free, and a deleted funnel
   DROPS incoming events instead of un-deleting itself. stock''s /get deliberately re-creates over
   a tombstone because the alternative is a game server that cannot sell; here the alternative is
   a mistyped funnel name that will not stay deleted, which is worse. Ingest still answers 200
   with {dropped: n} — a 4xx would make the Lua retry loop spin forever on data nobody wants.';

-- ---------------------------------------------------------------- funnel_step
-- The NAME column of the per-step table. Separate from funnel because it is one row per step;
-- inline as an array column it could not be updated without rewriting the funnel row every batch.
CREATE TABLE IF NOT EXISTS funnel_step (
  game_id     TEXT NOT NULL,
  funnel_name TEXT NOT NULL,
  step        INT  NOT NULL CHECK (step >= 1 AND step <= 100),
  step_name   TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (game_id, funnel_name, step),
  FOREIGN KEY (game_id, funnel_name) REFERENCES funnel(game_id, funnel_name) ON DELETE CASCADE
);

COMMENT ON COLUMN funnel_step.step_name IS
  'Display only, exactly as in Roblox''s API — never part of any key. Sent by the client on every
   flush as a `steps` array rather than registered by a separate call: ~80 bytes amortised over a
   batch, and it makes a rename self-healing (change the Lua, the panel catches up on the next
   flush, no migration and no admin action). The upsert carries a
   `WHERE step_name IS DISTINCT FROM EXCLUDED.step_name` guard so the steady state is zero writes
   rather than six rewritten rows per batch.';

-- ---------------------------------------------------------------- funnel_event
-- Append-only fact table. The ONLY dashboard element that reads it is AVG TIME.
--
-- There is deliberately NO surrogate `id BIGINT GENERATED ALWAYS AS IDENTITY`, unlike stock_ledger
-- and serial_ledger. Theirs exists to bound a purge against key re-creation — an idempotency
-- hazard, because a ledger row stores a RESULT that a retry replays. A funnel event stores no
-- result: a retry is a no-op, not a replay. Nothing needs a monotonic handle, so the identity
-- column and its unique index would be pure write amplification on the hottest insert here.
CREATE TABLE IF NOT EXISTS funnel_event (
  game_id       TEXT   NOT NULL,
  funnel_name   TEXT   NOT NULL,
  player_id     BIGINT NOT NULL,
  session_id    TEXT   NOT NULL DEFAULT '' CHECK (length(session_id) <= 64),
  step          INT    NOT NULL CHECK (step >= 1 AND step <= 100),
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  ms_since_prev INT CHECK (ms_since_prev >= 0),
  -- Exactly-once by construction: a retried or duplicated log is a no-op. THIS is what lets the
  -- ingest route omit the Idempotency-Key header entirely, following the /get precedent in
  -- stock.routes.ts rather than requiring a header the handler would ignore.
  UNIQUE (game_id, funnel_name, player_id, session_id, step)
);

COMMENT ON COLUMN funnel_event.player_id IS
  'Roblox UserId. BIGINT, not INT: UserIds passed 2^31 years ago. Stays below 2^53 so a JS Number
   is still exact on the way out — the same bound MAX_SERIAL uses in core/constants.ts.';

COMMENT ON COLUMN funnel_event.session_id IS
  'Roblox''s funnelSessionId: which pass through the funnel this is. Empty string, NEVER NULL — a
   NULL in a UNIQUE index is distinct from every other NULL, so a nullable column would silently
   disable deduplication for exactly the once-per-player funnels that need it most.

   Onboarding sends nothing -> '''' -> the key collapses to (game, funnel, player, step) and a step
   can never be logged twice. A repeating funnel sends a GUID per attempt -> each pass is
   independent. Both work with no branch anywhere in the code. Cheap now and expensive later:
   adding a column to a unique index on a live multi-million-row table is a REINDEX.';

COMMENT ON COLUMN funnel_event.occurred_at IS
  'When the client says the step happened, clamped in SQL to [now() - 15 min, now()].

   Clamped in SQL and not in Node on purpose: the range filter on the read side uses Postgres''
   clock, so clamping against Node''s would let a few seconds of container drift silently drop
   events out of the newest chart bucket — and that looks exactly like right-censoring, so nobody
   would notice. One clock for both sides.

   A future timestamp clamps to now(): a Roblox server with a skewed clock would otherwise park
   events in a bucket that has not happened, permanently. A stale one clamps UP to the floor
   rather than being rejected — dropping real data over a clock problem the game cannot see is the
   wrong trade. Clamps are counted in the funnel_events metric, not stored: a systematically
   skewed client shows up on a graph, which is the cheap version of the same information.';

COMMENT ON COLUMN funnel_event.ms_since_prev IS
  'Elapsed ms from the previous step of the same run, measured client-side and clamped here.

   This column is the whole reason AVG TIME is affordable. Computing it at read time needs
   lag(occurred_at) OVER (PARTITION BY player_id, session_id ORDER BY step) over every event in
   the range — a sort of roughly 75 MB at 30 days against work_mem=16MB, i.e. an external merge
   sort on disk, on a page a human reloads. Precomputed, AVG TIME is avg() over a range scan.

   NULL = unknown, and excluded from the average rather than counted as zero. That happens when a
   run crosses a server hop (player left and rejoined), so the panel returns the sample count
   alongside the average and says so.';

-- Serves the AVG TIME aggregate AND the retention sweep AND the panel purge — one index, three jobs.
--
-- occurred_at BEFORE step on purpose. Step-leading was considered: the aggregate does GROUP BY
-- step, so it would give tight per-step ranges instead of one wide one. But both read the same
-- rows for a given window, the GROUP BY is a handful of hash buckets either way, and step-leading
-- makes the range unusable for a query with no step filter — which is exactly what the retention
-- delete is. Time-leading serves both and avoids a THIRD index on the hottest insert path.
--
-- INCLUDE (ms_since_prev) is what makes AVG TIME an index-ONLY scan: it is the only heap column
-- the aggregate needs, and this table is append-only, so the visibility map goes all-visible and
-- stays there. 4 bytes per entry to never touch the heap.
CREATE INDEX IF NOT EXISTS funnel_event_read_idx
  ON funnel_event (game_id, funnel_name, occurred_at, step) INCLUDE (ms_since_prev);

-- ---------------------------------------------------------------- funnel_run
-- One row per (player, run): when they entered, how far they got, and their custom fields. Every
-- number on the tiles, the per-step PLAYERS column and the chart comes from this table alone.
--
-- THIS TABLE IS A CORRECTNESS MECHANISM BEFORE IT IS A PERFORMANCE ONE.
-- churn[N] = (players[N-1] - players[N]) / players[N-1] is only defined if players[] is
-- non-increasing. Counting distinct players per step from raw events does NOT guarantee that: one
-- dropped step-2 log from a server that shut down mid-flush gives players[3] > players[2], and the
-- panel renders a NEGATIVE churn rate and completion above 100%. Deriving every count from
-- max_step (maintained with GREATEST) makes monotonicity structural — no input can break it.
--
-- Because a funnel is ordered, max_step is sufficient: players[N] = count(*) WHERE max_step >= N,
-- so one scan yields every step count. Note the semantic this FIXES rather than introduces: a
-- player who logs step 3 without step 2 is counted at step 2, because reaching step 3 MEANS
-- passing step 2. That is what a funnel is; raw-event counting would disagree and would be wrong.
--
-- fillfactor 70 is load-bearing, not a guess. This is the only table in the schema updated ~6x per
-- row, and every one of those updates must stay HOT (heap-only, no index maintenance) or ingest
-- pays 6 index writes per run instead of 1. HOT needs free space on the SAME page.
CREATE TABLE IF NOT EXISTS funnel_run (
  game_id      TEXT   NOT NULL,
  funnel_name  TEXT   NOT NULL,
  player_id    BIGINT NOT NULL,
  session_id   TEXT   NOT NULL DEFAULT '' CHECK (length(session_id) <= 64),
  started_at   TIMESTAMPTZ NOT NULL,
  max_step     INT    NOT NULL CHECK (max_step >= 1 AND max_step <= 100),
  last_step_at TIMESTAMPTZ NOT NULL,
  cf1          TEXT,                                   -- Roblox CustomField01
  cf2          TEXT,                                   -- CustomField02
  cf3          TEXT,                                   -- CustomField03
  PRIMARY KEY (game_id, funnel_name, player_id, session_id)
) WITH (fillfactor = 70, autovacuum_vacuum_scale_factor = 0.05);

COMMENT ON COLUMN funnel_run.max_step IS
  'Highest step this run has reached. Maintained with GREATEST, never assigned. That is a hard rule
   for this whole table: every maintained column must be MONOTONIC (GREATEST/LEAST), never a
   counter. Monotonic means a replayed batch is a no-op, which is what makes the ingest endpoint
   idempotent without an Idempotency-Key header. An events_seen counter here would look harmless
   and would silently double-count on every network retry.';

COMMENT ON COLUMN funnel_run.started_at IS
  'When this run reached step 1 — maintained with LEAST, for the same reason as max_step. This is
   the cohort key, and having it on the same row as max_step is what makes cohort semantics
   structural: no query shape can accidentally mix cohort and activity semantics, because the
   entry time and the outcome are one row.

   No FK to funnel_event, and none to funnel either. An FK on the hottest INSERT costs a lookup per
   call, and it would force the retention sweep to delete in a particular order across two
   multi-million-row tables. The two share a natural key and are otherwise independent; a run row
   with no surviving events is a fact about retention, not a broken reference.';

COMMENT ON COLUMN funnel_run.cf1 IS
  'Roblox custom fields, for segmenting the dashboard ("which starter car gives the best
   progression"). Only CustomField01/02/03 exist in their API and anything else is ignored, so
   three columns is the whole domain — not a jsonb bag. They live on the run rather than the event
   because they describe the attempt, which also makes them filterable by the same index scan that
   already serves every other number on the page.

   Stored from the first migration even though the first UI only filters on them: adding a column
   to a multi-million-row table later is far worse than storing NULLs now.';

-- THE dashboard index: tiles, per-step PLAYERS, the chart and the p90 are all one range scan here.
--
-- Deliberately NO `INCLUDE (max_step, last_step_at)`, even though it would make every dashboard
-- query index-only. An INCLUDE column is still in the index's HOT-blocking attribute set, so
-- adding the two columns that change on every event would break HOT on the one table in this
-- schema that depends on it — trading 1 index write per run for 6, on the write path, to save heap
-- fetches on a read path whose heap is already fully cached. The wrong side of that trade, and the
-- single most consequential index decision in this file.
CREATE INDEX IF NOT EXISTS funnel_run_cohort_idx
  ON funnel_run (game_id, funnel_name, started_at);

-- ---------------------------------------------------------------- backfill
-- Keys minted before this migration carry the old four-scope set, so they would 403 on funnel
-- routes with nothing in the log pointing here. Grant the new scopes to every live key: they were
-- minted with "everything this game can do", and that set just grew.
UPDATE api_keys
SET scopes = scopes || ARRAY['funnel:read','funnel:write']
WHERE revoked_at IS NULL
  AND NOT (scopes @> ARRAY['funnel:read','funnel:write']);
