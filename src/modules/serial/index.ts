import type { FastifyInstance } from 'fastify';
import type { ResourceModule } from '../../core/module';
import { SerialRepository } from './serial.repository';
import { registerSerialRoutes } from './serial.routes';

/** Serial-number issuer module. Mounted at /v1/games/:gameId/serial. */
export const serialModule: ResourceModule = {
  name: 'serial',
  register(scope: FastifyInstance): void {
    const repo = new SerialRepository(scope.pg, scope.config.env.AUTO_PROVISION_GAMES);
    registerSerialRoutes(scope, repo);
  },
};

export default serialModule;
