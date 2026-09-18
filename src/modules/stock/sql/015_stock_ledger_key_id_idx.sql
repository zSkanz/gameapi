-- migrate:no-transaction
-- Swap the ledger's secondary index for one the code actually uses.
--
-- stock_ledger_key_time_idx (game_id, stock_key, created_at) is read by no query — nothing orders
-- or filters the ledger by time — yet every decrease pays to maintain it. Purge, the one query that
-- scans a key's ledger, asks for max(id) and then deletes id <= that in batches; with no index on
-- (game_id, stock_key, id) that walked every ledger row of the key, and a key with a long history
-- ran into statement_timeout, leaving purge unusable for exactly the keys that most need it.
--
-- CONCURRENTLY: the ledger is the biggest table and takes every purchase; a plain CREATE INDEX
-- would block its writes for the whole build. Re-runnable from the top (see migrate.ts).
DROP INDEX CONCURRENTLY IF EXISTS stock_ledger_key_id_idx;
CREATE INDEX CONCURRENTLY stock_ledger_key_id_idx ON stock_ledger (game_id, stock_key, id);
DROP INDEX CONCURRENTLY IF EXISTS stock_ledger_key_time_idx;
