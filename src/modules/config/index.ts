import type { FastifyInstance } from 'fastify';
import type { ResourceModule } from '../../core/module';
import { requireScope } from '../../core/http/guards';
import { describeAction, deliver, findWebhook } from '../panel/webhook';
import { ConfigRepository } from './config.repository';
import { registerConfigRoutes } from './config.routes';

/** Live configs for API keys. Mounted at /v1/games/:gameId/config. The panel mounts the same routes. */
export const configModule: ResourceModule = {
  name: 'config',
  register(scope: FastifyInstance): void {
    registerConfigRoutes(scope, new ConfigRepository(scope.pg), {
      path: (suffix) => suffix || '/',
      read: [requireScope('config:read')],
      // Drafts, authors and history belong to whoever may change the config, not to every game script.
      inspect: [requireScope('config:write')],
      write: [requireScope('config:write')],
      config: (docs, extra) => ({ docs, ...extra }),
      actor: (req) => `key:${req.principal!.keyId}`,
      // A panel author is a login username — half a panel credential. Keys see that a person did it, not who.
      author: (a) => (a === null || a.startsWith('key:') ? a : 'panel'),
    });

    // A config:write key changes what every live server reads, so its publishes and restores belong
    // in the game's Discord log exactly like a person's. The panel's notifier only sees panel
    // routes; this covers the API side, scoped to this module's routes by encapsulation.
    scope.addHook('onResponse', async (req, reply) => {
      if (req.method !== 'POST' || reply.statusCode >= 300 || !req.principal) return;
      const gameId = (req.params as { gameId?: string } | undefined)?.gameId;
      if (!gameId) return;
      void (async () => {
        try {
          const hook = await findWebhook(scope.pg, gameId);
          if (!hook) return;
          const action = describeAction({
            method: req.method,
            routeUrl: req.routeOptions.url ?? '',
            params: (req.params ?? {}) as Record<string, string | undefined>,
            body: req.body,
          });
          if (!action) return;
          await deliver(scope.pg, scope.log, hook, {
            username: `key:${req.principal!.keyId}`,
            role: 'API key',
            gameId,
            action,
            ip: req.ip,
          });
        } catch (err) {
          scope.log.warn({ err, gameId }, 'config webhook notify failed');
        }
      })();
    });
  },
};

export default configModule;
