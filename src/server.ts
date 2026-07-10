import { loadConfig } from './config/env';
import { buildApp } from './app';
import { runMigrations } from './core/db/migrate';

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await buildApp(config);

  // Run migrations at boot (advisory-locked, so concurrent replicas serialize safely).
  try {
    await runMigrations(app.pg, (m) => app.log.info(m));
  } catch (err) {
    app.log.error({ err }, 'migration failed');
    await app.close().catch(() => {});
    process.exit(1);
  }

  await app.listen({ host: config.env.HOST, port: config.env.PORT });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    const timer = setTimeout(() => {
      app.log.error('forced exit after shutdown timeout');
      process.exit(1);
    }, config.env.SHUTDOWN_TIMEOUT_MS);
    timer.unref();
    try {
      await app.close();
      clearTimeout(timer);
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
