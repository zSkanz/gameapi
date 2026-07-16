-- Panel accounts.
--
-- Sessions are NOT here: they live in Redis, keyed by a digest of the cookie value, with a
-- per-user generation counter so revoke-all is one INCR instead of a table scan.
--
-- There is NO panel_audit table either: every panel stock/serial mutation writes a
-- stock_ledger/serial_ledger row with api_key_id='panel:<userId>', and created_by /
-- deleted_by / revoked_at carry the rest. One history, not two that drift.

CREATE TABLE IF NOT EXISTS panel_user (
  user_id              TEXT PRIMARY KEY,                     -- 'pu_' + 16 hex
  username             TEXT NOT NULL,                        -- as typed; compared case-insensitively
  role                 TEXT NOT NULL CHECK (role IN ('owner','admin')),
  password_hash        TEXT NOT NULL,                        -- scrypt$N=..,r=..,p=..$salt$hash
  must_change_password BOOLEAN NOT NULL DEFAULT true,
  disabled_at          TIMESTAMPTZ,                          -- NULL = enabled. The ONLY disable
                                                             -- mechanism: there is no DELETE route,
                                                             -- so an `active`-style drift is impossible.
  password_changed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by           TEXT REFERENCES panel_user(user_id)   -- NULL for the bootstrap owner.
                                                             -- No ON DELETE clause: rows are never
                                                             -- deleted, disabling is the lever.
);

-- Case-insensitive uniqueness without the citext extension. Lookups MUST use
-- `WHERE lower(username) = lower($1)` to hit this index.
CREATE UNIQUE INDEX IF NOT EXISTS panel_user_username_lower_idx
  ON panel_user (lower(username));

-- Supports the "never zero owners" guard cheaply. Deliberately NOT a unique index on
-- role='owner': that would make ownership transfer impossible and turn every owner create
-- into a guaranteed 23505.
CREATE INDEX IF NOT EXISTS panel_user_owner_idx
  ON panel_user (role) WHERE role = 'owner' AND disabled_at IS NULL;
