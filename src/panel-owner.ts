import { loadConfig } from './config/env';
import { createPool } from './core/plugins/postgres';
import { runMigrations } from './core/db/migrate';
import { generatePassword } from './core/auth/password';
import { PanelRepository } from './modules/panel/panel.repository';
import { PANEL_USERNAME_REGEX } from './core/constants';

/**
 * The password a fresh owner gets. Deliberately well-known and weak: the whole point is that
 * first sign-in is "log in, change it on the page" with nothing to copy out of a terminal.
 * Safe only because must_change_password blocks every other panel route until it is changed —
 * and only for as long as it takes you to sign in. Use --random when that is not good enough.
 */
const DEFAULT_PASSWORD = 'owner123';

/**
 * Owner bootstrap and break-glass reset.
 *
 *   npm run panel:owner create [--username <name>] [--password <pw>] [--random]
 *   npm run panel:owner reset --username <name> [--password <pw>] [--random]
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
  const passwordFlag = args.indexOf('--password');
  const explicitPassword = passwordFlag >= 0 ? args[passwordFlag + 1] : undefined;

  if (command !== 'create' && command !== 'reset') {
    console.error('usage: panel-owner [create|reset] [--username <name>] [--password <pw>|--random]');
    process.exit(2);
  }
  if (explicitPassword !== undefined && explicitPassword.length < 6) {
    console.error('--password must be at least 6 characters.');
    process.exit(2);
  }
  if (username !== undefined && !PANEL_USERNAME_REGEX.test(username)) {
    console.error(`Invalid username. Must match ${PANEL_USERNAME_REGEX}`);
    process.exit(2);
  }

  // createPool, never `new Pool({connectionString, password})`: node-postgres merges the
  // connection string OVER the rest of the config, so a password embedded in DATABASE_URL
  // silently wins and the PGPASSWORD_FILE secret is discarded. That is the exact bug
  // core/plugins/postgres.ts exists to prevent — and this CLI is where it hurts most, since
  // `reset` is the only way back into a locked-out panel.
  const config = loadConfig();
  const pool = createPool(config);

  try {
    // Safe to re-run, and it means `panel:owner` works on a database that has never booted the
    // API — which is exactly the situation you are in the first time.
    await runMigrations(pool, () => {});
    const repo = new PanelRepository(pool);

    // Default is the well-known DEFAULT_PASSWORD so first sign-in is just "log in and change
    // it on the page", with nothing to copy out of a terminal. must_change_password gates every
    // other route until it is changed, so the window is bounded by your first login — but it is
    // a real window: the panel is internet-facing, and until you sign in, anyone who reaches it
    // and guesses the default owns it. --random restores the generated-secret behaviour.
    const password = args.includes('--random') ? generatePassword() : (explicitPassword ?? DEFAULT_PASSWORD);
    const isWellKnown = password === DEFAULT_PASSWORD;

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
      print(user.username, password, 'created', isWellKnown);
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
      print(user.username, password, 'reset', isWellKnown);
    }
  } finally {
    await pool.end();
  }
}

function print(username: string, password: string, what: string, isWellKnown: boolean): void {
  console.log('');
  console.log(`  Owner account ${what}.`);
  console.log('');
  console.log(`    username: ${username}`);
  console.log(`    password: ${password}`);
  console.log('');
  if (isWellKnown) {
    // Not a formality. The panel is internet-facing and this password is in the source code.
    console.log('  ** This is the well-known default password. Sign in and change it NOW. **');
    console.log('  Until you do, anyone who reaches /panel and guesses it becomes the owner.');
    console.log('  Prefer a generated secret? Re-run with --random.');
  } else {
    console.log('  Shown once — it is not recoverable. Sign in and you will be asked to change it.');
  }
  console.log('');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
