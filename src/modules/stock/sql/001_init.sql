-- Stock module schema. Postgres is the SINGLE source of truth; every mutation is atomic
-- via a single SQL statement (row-locked read-modify-write). No Redis, no Lua.

-- live authoritative stock
CREATE TABLE IF NOT EXISTS stock (
  game_id       TEXT   NOT NULL REFERENCES game(game_id),
  stock_key     TEXT   NOT NULL,
  current_stock BIGINT NOT NULL CHECK (current_stock >= 0),
  max_stock     BIGINT NOT NULL CHECK (max_stock >= 0 AND max_stock <= 1000000000),
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (game_id, stock_key),
  CHECK (current_stock <= max_stock)
);

-- append-only audit ledger; also the idempotency store (one row per (key, event_id))
CREATE TABLE IF NOT EXISTS stock_ledger (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id     TEXT   NOT NULL,               -- == Idempotency-Key (or create:<game>:<key>)
  game_id      TEXT   NOT NULL,
  stock_key    TEXT   NOT NULL,
  op           TEXT   NOT NULL,               -- decrease | adjust | create | set_max
  requested    BIGINT,
  applied      BIGINT NOT NULL,               -- signed actual change
  new_value    BIGINT NOT NULL CHECK (new_value >= 0),
  fingerprint  TEXT,                          -- request fingerprint; detects key reuse w/ different body
  api_key_id   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (game_id, stock_key, event_id)       -- exactly-once: a retried mutation is a no-op replay
);
CREATE INDEX IF NOT EXISTS stock_ledger_key_time_idx ON stock_ledger (game_id, stock_key, created_at DESC);
