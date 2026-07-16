-- Per-game Discord webhook: a human-readable log of what admins do in the panel.
--
-- NOT an audit trail. The ledger in Postgres is the audit trail; this is a notification that
-- may silently miss entries (delivery is fire-and-forget, and a game server can be told
-- nothing at all). Kept in its own table rather than on `game` so the URL — which is a bearer
-- secret, anyone holding it can post as you — is never selected by the game-facing reads.

CREATE TABLE IF NOT EXISTS game_webhook (
  game_id         TEXT PRIMARY KEY REFERENCES game(game_id),
  url             TEXT NOT NULL,
  enabled         BOOLEAN NOT NULL DEFAULT true,
  -- Delivery health, so a dead webhook is visible in the panel instead of just silent.
  last_status     INT,                      -- HTTP status of the last attempt; NULL = never sent
  last_error      TEXT,                     -- short reason for the last failure
  last_ok_at      TIMESTAMPTZ,
  last_attempt_at TIMESTAMPTZ,
  created_by      TEXT,                     -- panel:<userId>
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
