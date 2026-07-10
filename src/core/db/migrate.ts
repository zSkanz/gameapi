import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Pool } from 'pg';

/** Deterministic advisory-lock id so concurrent deployers serialize migrations. */
const MIGRATION_LOCK_ID = 4_820_115;

/** Recursively collect every *.sql file under `root`. */
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
      else if (e.name.endsWith('.sql')) out.push(abs);
    }
  }
  await walk(root);
  return out;
}

/**
 * Apply pending SQL migrations in filename order. Migrations are globbed from the whole
 * source tree (core + every modules/<x>/sql), so adding a module needs no core edit.
 * Each file runs once, tracked in schema_migrations, inside its own transaction.
 */
export async function runMigrations(pool: Pool, log: (msg: string) => void = console.log): Promise<void> {
  // src root: dist/ in prod, src/ in dev (this file lives at <root>/core/db/migrate).
  const root = path.resolve(__dirname, '..', '..');
  const files = (await findSqlFiles(root)).sort((a, b) =>
    path.basename(a).localeCompare(path.basename(b)),
  );

  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
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
