import type { FastifyInstance } from 'fastify';
import { requireScope } from '../../core/http/guards';
import type { ConfigRepository } from '../config/config.repository';
import { registerConfigRoutes } from '../config/config.routes';

/**
 * The panel's side of live configs: the same routes as /v1/games/:gameId/config, behind a session.
 * Admins may edit and publish (panel:write), like stock and serials — a config is game data.
 */
export function registerPanelConfigRoutes(app: FastifyInstance, repo: ConfigRepository): void {
  registerConfigRoutes(app, repo, {
    path: (suffix) => `/games/:gameId/config${suffix}`,
    read: [requireScope('panel:read')],
    inspect: [requireScope('panel:read')],
    write: [requireScope('panel:write')],
    config: () => ({ session: true }),
    actor: (req) => req.panel!.username,
  });
}
