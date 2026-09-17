-- The Open Cloud key becomes optional. A game can now be linked to its Roblox universe just to see
-- its stats, badges and game passes in the panel — which needs only the universe ID. The key is
-- still required to publish messages, and the publish route says so when it is missing.
--
-- DROP NOT NULL is metadata-only, and every existing row already has a key.

ALTER TABLE game_roblox ALTER COLUMN api_key DROP NOT NULL;
