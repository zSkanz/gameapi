-- migrate:no-transaction
-- The serial ledger's twin of 015_stock_ledger_key_id_idx.sql: an index for purge's max(id) and
-- id-bounded drain instead of the (…, created_at) one no query reads. CONCURRENTLY, re-runnable.
DROP INDEX CONCURRENTLY IF EXISTS serial_ledger_key_id_idx;
CREATE INDEX CONCURRENTLY serial_ledger_key_id_idx ON serial_ledger (game_id, serial_key, id);
DROP INDEX CONCURRENTLY IF EXISTS serial_ledger_key_time_idx;
