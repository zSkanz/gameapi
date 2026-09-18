import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Pool, PoolClient } from 'pg';

/** Deterministic advisory-lock id so concurrent deployers serialize migrations. */
const MIGRATION_LOCK_ID = 4_820_115;

/**
 * Recursively collect every *.sql file that sits inside a `sql/` directory.
 *
 * The `sql/` segment is a hard requirement, not a convention: this walks the whole build
 * output, and the panel SPA also writes into dist/. Any .sql a bundler happened to emit as
 * an asset would otherwise be executed against production Postgres.
 */
async function findSqlFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // directory may not exist (e.g. no core/sql yet)
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) await walk(abs);
      else if (e.name.endsWith('.sql') && path.basename(path.dirname(abs)) === 'sql') out.push(abs);
    }
  }
  await walk(root);
  return out;
}

/**
 * First line of a migration that must run OUTSIDE a transaction — CREATE/DROP INDEX CONCURRENTLY,
 * which Postgres refuses inside one, and which is the only way to index a large live table (a
 * ledger) without blocking its writes for the whole build.
 *
 * Such a file runs one statement at a time (split at a `;` that ends a line), with no statement
 * timeout, and is recorded only after the last one succeeds. A failure part-way leaves the earlier
 * statements applied and the file unrecorded, so the next deploy re-runs it FROM THE TOP: write it
 * to be safe to repeat (DROP ... IF EXISTS before each CREATE, so a failed CONCURRENTLY build's
 * INVALID index is replaced rather than skipped by IF NOT EXISTS).
 */
const NO_TRANSACTION = '-- migrate:no-transaction';

async function applyWithoutTransaction(client: PoolClient, name: string, sql: string, log: (msg: string) => void): Promise<void> {
  const statements = sql
    .split(/;\s*$/m)
    .map((s) => s.trim())
    // A chunk of nothing but comments is not a statement.
    .filter((s) => s.split('\n').some((line) => line.trim() !== '' && !line.trim().startsWith('--')));
  try {
    // The pool's 5s statement_timeout is for request traffic; an index build on a big table takes longer.
    await client.query('SET statement_timeout = 0');
    for (const statement of statements) {
      // Logged one by one: a CONCURRENTLY build waits for every older transaction to finish — a
      // long pg_dump included — and with no timeout, a silent wait would look like a hung deploy.
      // Check pg_stat_activity for what it is waiting on.
      log(`migrate: ${name}: ${statement.replace(/^--.*$/gm, '').trim().split(/$/m)[0]}`);
      await client.query(statement);
    }
    await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [name]);
  } catch (err) {
    throw new Error(`Migration ${name} failed: ${(err as Error).message}`);
  } finally {
    await client.query('RESET statement_timeout').catch(() => {});
  }
}

/**
 * Apply pending SQL migrations in filename order. Migrations are globbed from the whole
 * source tree (core + every modules/<x>/sql), so adding a module needs no core edit.
 * Each file runs once, tracked in schema_migrations, inside its own transaction — or, when marked
 * NO_TRANSACTION, statement by statement.
 */
export async function runMigrations(pool: Pool, log: (msg: string) => void = console.log): Promise<void> {
  // src root: dist/ in prod, src/ in dev (this file lives at <root>/core/db/migrate).
  const root = path.resolve(__dirname, '..', '..');
  const files = (await findSqlFiles(root)).sort((a, b) =>
    path.basename(a).localeCompare(path.basename(b)),
  );

  const client = await pool.connect();
  try {
    // Polled, not a blocking pg_advisory_lock: a session blocked inside that call holds a snapshot
    // for as long as it waits, and CREATE INDEX CONCURRENTLY (see NO_TRANSACTION) waits for every
    // older snapshot to go away — while that waiter waits for the lock the index builder holds.
    // Postgres breaks the cycle by aborting one side, which can be the builder, on every replica in
    // turn. Between two short tries a waiting process holds no snapshot at all.
    let waitingLogged = false;
    while (!(await client.query('SELECT pg_try_advisory_lock($1) AS ok', [MIGRATION_LOCK_ID])).rows[0].ok) {
      if (!waitingLogged) log('migrate: another process is migrating; waiting for it');
      waitingLogged = true;
      await new Promise((r) => setTimeout(r, 1_000));
    }
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         filename    TEXT PRIMARY KEY,
         applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
    );
    const applied = new Set(
      (await client.query('SELECT filename FROM schema_migrations')).rows.map((r) => r.filename),
    );

    for (const file of files) {
      const name = path.basename(file);
      if (applied.has(name)) continue;
      const sql = await fs.readFile(file, 'utf8');
      log(`migrate: applying ${name}`);
      if (sql.startsWith(NO_TRANSACTION)) {
        await applyWithoutTransaction(client, name, sql, log);
        continue;
      }
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [name]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${name} failed: ${(err as Error).message}`);
      }
    }
    log('migrate: up to date');
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => {});
    client.release();
  }
}
