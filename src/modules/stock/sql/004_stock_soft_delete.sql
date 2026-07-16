-- Soft delete for stock keys. deleted_at is the ONLY liveness signal; every read path filters
-- it and every write path refuses a deleted key.
--
-- The row keeps its name, its values and its ledger, so restore is a pure un-delete and a
-- stale Idempotency-Key replaying across delete->restore is CORRECT (it is the same
-- incarnation). Only purge (owner-only) frees the name, and it takes the ledger with it.
--
-- There is deliberately NO epoch/incarnation column: re-creating over a soft-deleted row is
-- refused (409), so a second incarnation can never coexist with the first's ledger — there is
-- nothing to namespace. An epoch would also force claim(), the hottest write in the system,
-- to read the stock row before inserting.
--
-- Nullable with no DEFAULT -> PG11+ catalog-only change, no table rewrite. Safe on a live table.
--
-- NO new index: the PK (game_id, stock_key) already serves list()'s prefix scan in stock_key
-- order, and `deleted_at IS NULL` is a free heap filter on top. A partial index would
-- duplicate the PK and add write amplification to every decrease.

ALTER TABLE stock ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE stock ADD COLUMN IF NOT EXISTS deleted_by TEXT;   -- 'panel:<userId>'

COMMENT ON COLUMN stock_ledger.api_key_id IS
  'Actor, discriminated by prefix: env:* (.env bootstrap key) | gk_* (per-game key) |
   panel:<userId> (a human in the panel). Deliberately NOT renamed to actor_id: migrations run
   in-process, so a rename would 500 every decrease on old replicas mid-rollout (42703). No FK:
   it holds non-key actors, and an FK on the hottest INSERT costs a lookup per call.';
