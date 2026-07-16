-- Soft delete for serial issuers. Same rules as stock (see 004_stock_soft_delete.sql):
-- deleted_at is the only liveness signal, restore is a pure un-delete, and re-create over a
-- deleted row is refused rather than resurrecting it.
--
-- A serial can also be linked to a stock key. A deleted LINKED STOCK is not the same thing as
-- a deleted serial: the serial stays live but can issue nothing, because its supply is gone.
-- issue() reports those two cases distinctly instead of both claiming "depleted".

ALTER TABLE serial ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE serial ADD COLUMN IF NOT EXISTS deleted_by TEXT;   -- 'panel:<userId>'

COMMENT ON COLUMN serial_ledger.api_key_id IS
  'Actor, discriminated by prefix: env:* | gk_* | panel:<userId>. See stock_ledger.api_key_id.';
