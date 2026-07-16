-- Per-game Roblox Open Cloud connection, so the panel can push a MessagingService message to
-- the live servers of an experience.
--
-- Its own table, like game_webhook and for the same reason: api_key is a bearer secret with
-- publish rights on a real experience, and it must never be selectable by a game-facing read.
-- It goes in and never comes back out — the panel only ever sees whether one is set.

CREATE TABLE IF NOT EXISTS game_roblox (
  game_id         TEXT PRIMARY KEY REFERENCES game(game_id),
  universe_id     TEXT NOT NULL,            -- digits; Creator Dashboard -> Copy Universe ID
  api_key         TEXT NOT NULL,            -- Open Cloud key, scope universe-messaging-service:publish
  -- Delivery health, so a rotated or expired key is visible here instead of silently failing.
  last_status     INT,
  last_error      TEXT,
  last_ok_at      TIMESTAMPTZ,
  last_attempt_at TIMESTAMPTZ,
  -- Which Open Cloud version actually worked last time. v2 is documented but still beta and v1
  -- is undocumented but live, so this records what the fallback settled on rather than leaving
  -- it to be guessed from logs.
  last_api        TEXT,
  created_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
