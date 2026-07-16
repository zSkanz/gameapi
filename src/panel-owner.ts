import { Pool } from 'pg';
import { loadConfig } from './config/env';
import { runMigrations } from './core/db/migrate';
import { generatePassword } from './core/auth/password';
import { PanelRepository } from './modules/panel/panel.repository';
import { PANEL_USERNAME_REGEX } from './core/constants';

/**
 * Owner bootstrap and break-glass reset.
 *
 *   npm run panel:owner create [--username <name>]
 *   npm run panel:owner reset --username <name>
 *
 * A CLI rather than a seed-on-boot: server.ts runs buildApp BEFORE runMigrations, so seeding
 * inside a plugin would hit a table that does not exist yet and crash-loop a fresh database.
 * It would also race across CLUSTER_WORKERS.
 *
 * The password is GENERATED and printed once, never read from an env var: PANEL_OWNER_PASSWORD
 * would sit in .env forever, and rotating it there would silently do nothing.
 *
 * `reset` is not optional — it is the only way back in. There is no email, no self-serve
 * reset, and the sole owner cannot ask anyone else to reset them.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] ?? 'create';
  const usernameFlag = args.indexOf('--username');
  const username = usernameFlag >= 0 ? args[usernameFlag + 1] : undefined;

  if (command !== 'create' && command !== 'reset') {
    console.error('usage: panel-owner [create|reset] [--username <name>]');
    process.exit(2);
  }
  if (username !== undefined && !PANEL_USERNAME_REGEX.test(username)) {
    console.error(`Invalid username. Must match ${PANEL_USERNAME_REGEX}`);
    process.exit(2);
  }

  const config = loadConfig();
  const pool = new Pool({
    connectionString: config.env.DATABASE_URL,
    password: config.pgPassword,
    max: 2,
  });

  try {
    // Safe to re-run, and it means `panel:owner` works on a database that has never booted the
    // API — which is exactly the situation you are in the first time.
    await runMigrations(pool, () => {});
    const repo = new PanelRepository(pool);
    const password = generatePassword();

    if (command === 'create') {
      const existing = await repo.countOwners();
      if (existing > 0 && !username) {
        // Idempotent: re-running the bootstrap must not mint a second owner or reset the first.
        console.log(`An owner already exists. Nothing to do.`);
        console.log(`(To add another account, use the panel. To reset a password: panel:owner reset --username <name>)`);
        return;
      }
      const name = username ?? 'owner';
      const user = await repo.create(name, password, 'owner', null);
      print(user.username, password, 'created');
    } else {
      if (!username) {
        console.error('reset requires --username <name>');
        process.exit(2);
      }
      const user = await repo.findForAuth(username);
      if (!user) {
        console.error(`No account named ${username}.`);
        process.exit(1);
      }
      await repo.resetPassword(user.userId, password);
      print(user.username, password, 'reset');
    }
  } finally {
    await pool.end();
  }
}

function print(username: string, password: string, what: string): void {
  // stdout, once. It is not stored anywhere and cannot be recovered.
  console.log('');
  console.log(`  Owner account ${what}.`);
  console.log('');
  console.log(`    username: ${username}`);
  console.log(`    password: ${password}`);
  console.log('');
  console.log('  Shown once — it is not recoverable. Sign in and you will be asked to change it.');
  console.log('');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
