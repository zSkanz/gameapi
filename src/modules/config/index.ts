import type { FastifyInstance } from 'fastify';
import type { ResourceModule } from '../../core/module';
import { requireScope } from '../../core/http/guards';
import { ConfigRepository } from './config.repository';
import { registerConfigRoutes } from './config.routes';

/** Live configs for API keys. Mounted at /v1/games/:gameId/config. The panel mounts the same routes. */
export const configModule: ResourceModule = {
  name: 'config',
  register(scope: FastifyInstance): void {
    registerConfigRoutes(scope, new ConfigRepository(scope.pg), {
      path: (suffix) => suffix || '/',
      read: [requireScope('config:read')],
      write: [requireScope('config:write')],
      config: (docs) => ({ docs }),
      actor: (req) => `key:${req.principal!.keyId}`,
    });
  },
};

export default configModule;
