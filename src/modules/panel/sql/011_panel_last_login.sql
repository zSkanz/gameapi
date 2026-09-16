-- When each panel account last signed in successfully. The Accounts page always rendered this
-- column, but nothing ever stored it, so every account read "never".
--
-- Nullable with no default: a metadata-only change (no table rewrite), and NULL is the honest
-- value for existing accounts — their earlier logins were never recorded.

ALTER TABLE panel_user ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;
