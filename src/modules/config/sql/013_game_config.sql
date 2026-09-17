-- Live game configs: typed key/values a game reads at runtime and an operator changes without
-- republishing the experience. Modelled on Roblox's own Experience Configs — a staged draft,
-- publishing it cuts a numbered version, every version is kept with its diff, and any version can
-- be restored into the draft — but stored here, so a game reads them through this API.
--
-- One row per game holds the published state and the draft side by side. The whole config is a
-- JSONB object ({ key: { type, value, description, updatedAt } }) rather than a row per key:
-- publishing is an atomic swap of the full state, the diff is computed in one place, and a game
-- always reads a single consistent version — never half of a publish.

CREATE TABLE IF NOT EXISTS game_config (
  game_id          TEXT PRIMARY KEY REFERENCES game(game_id),
  version          BIGINT NOT NULL DEFAULT 0,               -- 0 = never published
  published        JSONB NOT NULL DEFAULT '{}'::jsonb,
  published_at     TIMESTAMPTZ,
  published_by     TEXT,                                    -- display label: panel username or key id
  draft            JSONB,                                   -- full intended state; NULL = no pending changes
  -- Bumped on every draft write. A writer that sends the revision it read gets a conflict instead
  -- of silently overwriting someone else's edit (same idea as Roblox's draftHash).
  draft_revision   BIGINT NOT NULL DEFAULT 0,
  draft_updated_at TIMESTAMPTZ,
  draft_updated_by TEXT
);

CREATE TABLE IF NOT EXISTS game_config_revision (
  game_id      TEXT NOT NULL REFERENCES game(game_id),
  version      BIGINT NOT NULL,
  entries      JSONB NOT NULL,                              -- the full published state at this version
  changes      JSONB NOT NULL,                              -- { key: { before, after } }, null = absent
  message      TEXT,
  published_by TEXT,
  published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (game_id, version)
);
