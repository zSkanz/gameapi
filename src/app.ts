import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AppConfig } from './config/env';
import { registerErrorHandler } from './core/plugins/error-handler';
import { httpHooksPlugin } from './core/plugins/http-hooks';
import { postgresPlugin } from './core/plugins/postgres';
import { redisPlugin } from './core/plugins/redis';
import { authPlugin } from './core/plugins/auth';
import { rateLimitPlugin } from './core/plugins/ratelimit';
import { healthPlugin } from './core/plugins/health';
import type { ResourceModule } from './core/module';
import { stockModule } from './modules/stock';

/** Every resource module. Add a new module here (its folder is otherwise self-contained). */
const MODULES: ResourceModule[] = [stockModule];

export async function buildApp(config: AppConfig): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.env.LOG_LEVEL,
      redact: ['req.headers["x-api-key"]', 'req.headers.authorization'],
    },
    trustProxy: config.env.TRUST_PROXY,
    bodyLimit: config.env.BODY_LIMIT_BYTES,
    genReqId: () => randomUUID(),
  });

  app.decorate('config', config);
  registerErrorHandler(app);

  // Cross-cutting hooks + infra. Order matters for onRequest hooks: auth before rate limit.
  await httpHooksPlugin(app);
  await postgresPlugin(app);
  await redisPlugin(app);
  await authPlugin(app);
  await rateLimitPlugin(app);
  await healthPlugin(app);

  // Mount each module under /v1/games/:gameId/<name>
  for (const mod of MODULES) {
    await app.register(
      async (scope) => {
        await mod.register(scope);
      },
      { prefix: `/v1/games/:gameId/${mod.name}` },
    );
  }

  return app;
}
