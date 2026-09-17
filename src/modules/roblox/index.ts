import type { FastifyInstance } from 'fastify';
import type { ResourceModule } from '../../core/module';
import { registerRobloxRoutes } from './roblox.routes';

/** Public Roblox data a game server cannot fetch itself. Mounted at /v1/games/:gameId/roblox. */
export const robloxModule: ResourceModule = {
  name: 'roblox',
  register(scope: FastifyInstance): void {
    registerRobloxRoutes(scope);
  },
};

export default robloxModule;
