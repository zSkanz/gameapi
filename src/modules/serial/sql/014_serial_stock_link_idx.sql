-- migrate:no-transaction
-- "Which live serials draw from this stock key?" — asked by the stock list (panel and game), stock
-- delete and stock purge. serial had only its primary key (game_id, serial_key), so each of those
-- scanned every serial of the game, once per stock row on the list.
--
-- CONCURRENTLY, so building it never blocks issue() (which updates serial rows). Written to be
-- re-run from the top: see NO_TRANSACTION in src/core/db/migrate.ts.
DROP INDEX CONCURRENTLY IF EXISTS serial_stock_link_idx;
CREATE INDEX CONCURRENTLY serial_stock_link_idx ON serial (game_id, stock_key) WHERE stock_key IS NOT NULL;
