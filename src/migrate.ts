import { loadConfig } from './config/env';
import { createPool } from './core/plugins/postgres';
import { runMigrations } from './core/db/migrate';

/** Standalone migration entrypoint (dist/migrate.js) used by ops/deploy.sh. */
async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config);
  try {
    await runMigrations(pool);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
