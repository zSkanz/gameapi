-- Per-game API keys. api_keys shipped in 000_core_init.sql but was never referenced by any
-- code; this migration makes it the real auth source.
--
-- Migrations are sorted AND tracked by basename only (core/db/migrate.ts): a basename
-- collision is silently marked applied and never runs. 000/001/002 are taken.

-- Assumption guard: the table is provably unused in every environment (zero code references
-- until this commit). Fail LOUDLY rather than silently dropping a column with rows in it.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM api_keys) THEN
    RAISE EXCEPTION 'api_keys unexpectedly non-empty — migrate manually';
  END IF;
END $$;

-- A DB key is ALWAYS scoped to exactly one game. Wildcard access exists in exactly one
-- place: the .env bootstrap key, behind BOOTSTRAP_API_KEY_ENABLED. Leaving this nullable
-- would let a single mis-inserted row mint a global key that no flag can switch off.
ALTER TABLE api_keys ALTER COLUMN game_id SET NOT NULL;

-- One disable mechanism. `active` and `revoked_at` overlap and would drift; revoked_at wins
-- because it carries the audit timestamp and revocation is inherently permanent.
ALTER TABLE api_keys DROP COLUMN IF EXISTS active;

-- Human label: gk_ab12cd34ef56 is unreadable, and the panel's key list is useless without it.
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS label      TEXT NOT NULL DEFAULT '';
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS created_by TEXT;   -- panel:<userId>

-- The panel's per-game key list. Non-partial: it serves both active-only and include-revoked.
-- The hot-path lookup needs no index — key_id is already the PK.
CREATE INDEX IF NOT EXISTS api_keys_game_idx ON api_keys (game_id);

-- The FK to game stays NO ACTION. ON DELETE CASCADE would fix nothing (stock.game_id and
-- serial.game_id are already NOT NULL REFERENCES game(game_id) with NO ACTION, so deleting a
-- game already FK-errors) while silently shredding the key labels that a ledger's api_key_id
-- resolves to.

COMMENT ON COLUMN api_keys.secret_hash IS
  'hex sha256(secret). NOT a slow KDF, by design: the secret is 32 CSPRNG bytes (256 bits), so
   there is no dictionary to slow down, and resolve() runs on EVERY request from EVERY Roblox
   server — a KDF here caps a worker at ~34 rps against a 6000/min limit. The argon2id comment
   in 000_core_init.sql was aspirational; no argon2 dependency ever existed. Panel passwords
   are a different problem and DO use scrypt. See src/core/auth/key-format.ts.';

COMMENT ON COLUMN api_keys.tier IS
  'Unused. Nothing reads it; the limiter takes a flat RATE_LIMIT_KEY_PER_MIN. Kept because
   dropping it is a migration for nothing; wire it when a tier->limit map exists.';
