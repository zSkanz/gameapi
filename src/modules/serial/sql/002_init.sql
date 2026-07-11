-- Serial module: issues unique sequential numbers (edition/serial numbers).
-- A serial has its own monotonic counter (next_num) starting at start_num. It can be:
--   * infinite     (max_num NULL, stock_key NULL) — just counts up from start_num
--   * capped        (max_num set) — issues start_num..max_num, then exhausted
--   * stock-linked  (stock_key set) — each issue also decrements that stock; 0 = exhausted
-- max_num and stock_key can be combined; either one gates issuing.

CREATE TABLE IF NOT EXISTS serial (
  game_id    TEXT   NOT NULL REFERENCES game(game_id),
  serial_key TEXT   NOT NULL,
  start_num  BIGINT NOT NULL,
  next_num   BIGINT NOT NULL,            -- next number to be issued
  max_num    BIGINT,                     -- NULL = infinite
  stock_key  TEXT,                       -- NULL = not linked to a stock (no FK: the stock may be created later)
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (game_id, serial_key),
  CHECK (next_num >= start_num),
  CHECK (max_num IS NULL OR max_num >= start_num)
);

-- idempotency + audit: one row per (serial, event_id); stores the number that was issued
CREATE TABLE IF NOT EXISTS serial_ledger (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id    TEXT   NOT NULL,           -- == Idempotency-Key
  game_id     TEXT   NOT NULL,
  serial_key  TEXT   NOT NULL,
  issued      BIGINT NOT NULL,           -- the number handed out (0 until filled)
  api_key_id  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (game_id, serial_key, event_id) -- exactly-once: a retried issue replays the same number
);
CREATE INDEX IF NOT EXISTS serial_ledger_key_time_idx ON serial_ledger (game_id, serial_key, created_at DESC);
