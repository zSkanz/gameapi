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
import { docsPlugin } from './core/docs/docs.plugin';
import { panelStaticPlugin } from './core/panel/panel-static.plugin';
import { registerGamesRoutes } from './core/games';
import type { ResourceModule } from './core/module';
import { stockModule } from './modules/stock';
import { serialModule } from './modules/serial';
import { funnelModule } from './modules/funnel';
import { robloxModule } from './modules/roblox';
import { panelPlugin } from './modules/panel';

/** Every resource module. Add a new module here (its folder is otherwise self-contained). */
const MODULES: ResourceModule[] = [stockModule, serialModule, funnelModule, robloxModule];

export async function buildApp(config: AppConfig): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.env.LOG_LEVEL,
      // The cookie entries are not decoration: the session cookie IS the credential, so an
      // unredacted request log would hand every session to anyone who can read logs.
      redact: [
        'req.headers["x-api-key"]',
        'req.headers.authorization',
        'req.headers.cookie',
        'res.headers["set-cookie"]',
      ],
    },
    trustProxy: config.env.TRUST_PROXY,
    bodyLimit: config.env.BODY_LIMIT_BYTES,
    genReqId: () => randomUUID(),
    ignoreTrailingSlash: true,
  });

  app.decorate('config', config);
  registerErrorHandler(app);

  // Cross-cutting hooks + infra. Order matters for onRequest hooks: auth before rate limit.
  await httpHooksPlugin(app);
  await postgresPlugin(app);
  await redisPlugin(app);
  await authPlugin(app);
  await rateLimitPlugin(app);
  // BEFORE docsPlugin: the SPA's routes are transport, not API, so letting the onRoute hook
  // capture them would list index.html in the public endpoint catalogue.
  panelStaticPlugin(app);
  // docs must be registered before health + modules so its onRoute hook captures them
  await docsPlugin(app);
  await healthPlugin(app);
  registerGamesRoutes(app);

  // AFTER docsPlugin on purpose: onRoute only fires for routes registered after the hook
  // exists, so registering the panel earlier would leave docs' panel filter matching nothing —
  // dead code that looks like the control keeping the admin API out of the public catalogue.
  await app.register(panelPlugin, { prefix: '/v1/panel' });

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
