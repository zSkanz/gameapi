-- Core schema: tenant registry shared by every module.
-- Idempotent so the migration runner can re-apply safely on a fresh DB.

CREATE TABLE IF NOT EXISTS game (
  game_id    TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'active',   -- active | disabled
  max_keys   INT  NOT NULL DEFAULT 10000,       -- per-game key quota (noisy-neighbor guard)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Future multi-key auth (DbApiKeyStore). Unused while the single .env key is wildcard.
CREATE TABLE IF NOT EXISTS api_keys (
  key_id       TEXT PRIMARY KEY,                 -- public prefix, e.g. 'gk_ab12cd'
  game_id      TEXT REFERENCES game(game_id),    -- NULL = multi-game/global
  secret_hash  TEXT NOT NULL,                    -- argon2id(secret); NEVER plaintext
  scopes       TEXT[] NOT NULL DEFAULT '{}',
  tier         TEXT NOT NULL DEFAULT 'default',
  active       BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ
);
