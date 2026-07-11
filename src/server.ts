import cluster from 'node:cluster';
import { loadConfig, type AppConfig } from './config/env';
import { buildApp } from './app';
import { createPool } from './core/plugins/postgres';
import { runMigrations } from './core/db/migrate';

async function serve(config: AppConfig, migrate: boolean): Promise<void> {
  const app = await buildApp(config);

  if (migrate) {
    try {
      await runMigrations(app.pg, (m) => app.log.info(m));
    } catch (err) {
      app.log.error({ err }, 'migration failed');
      await app.close().catch(() => {});
      process.exit(1);
    }
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

async function main(): Promise<void> {
  const config = loadConfig();
  const workers = config.env.CLUSTER_WORKERS;

  // single process: it runs migrations then serves
  if (workers <= 1) {
    await serve(config, true);
    return;
  }

  // cluster primary: migrate once, fork workers, forward shutdown, restart on crash
  if (cluster.isPrimary) {
    const pool = createPool(config);
    try {
      await runMigrations(pool, (m) => console.log(JSON.stringify({ level: 'info', msg: m })));
    } finally {
      await pool.end();
    }

    let stopping = false;
    for (let i = 0; i < workers; i++) cluster.fork();
    cluster.on('exit', (worker, code, signal) => {
      if (stopping) return;
      console.error(`worker ${worker.process.pid} died (${signal || code}); restarting`);
      cluster.fork();
    });

    const stop = (sig: NodeJS.Signals): void => {
      stopping = true;
      for (const w of Object.values(cluster.workers ?? {})) w?.kill(sig);
      setTimeout(() => process.exit(0), config.env.SHUTDOWN_TIMEOUT_MS).unref();
    };
    process.on('SIGTERM', () => stop('SIGTERM'));
    process.on('SIGINT', () => stop('SIGINT'));
    return;
  }

  // cluster worker: serve without migrating (the primary already did)
  await serve(config, false);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
