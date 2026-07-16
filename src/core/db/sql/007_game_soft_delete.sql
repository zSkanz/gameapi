-- Soft delete for games (tenants). Same rule as stock/serial: deleting is a control-plane act,
-- the row keeps everything it had, and restore is a pure un-delete.
--
-- A deleted game must be INERT — its API keys stop authenticating. That is enforced by a join
-- in DbApiKeyStore rather than by revoking the keys on delete: revoking is not reversible, so
-- restore would silently leave every integration broken with no sign of why. The join costs
-- nothing measurable — game_id is a primary key, and the lookup it rides on is cached 30s.
--
-- `status` (active|disabled) already existed here and has never been read by anything. It stays
-- untouched rather than being repurposed: deleted_at means one thing, and a second overlapping
-- liveness signal is how the api_keys `active`/`revoked_at` drift happened.
--
-- Nullable, no DEFAULT -> PG11+ catalog-only, no table rewrite. Safe on a live table.

ALTER TABLE game ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE game ADD COLUMN IF NOT EXISTS deleted_by TEXT;   -- 'panel:<userId>'
