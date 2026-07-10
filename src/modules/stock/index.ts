import type { FastifyInstance } from 'fastify';
import type { ResourceModule } from '../../core/module';
import { StockRepository } from './stock.repository';
import { StockService } from './stock.service';
import { registerStockRoutes } from './stock.routes';

/**
 * The stock module. Postgres-only: wire repository -> service -> routes.
 * Mounted at /v1/games/:gameId/stock by app.ts.
 */
export const stockModule: ResourceModule = {
  name: 'stock',
  register(scope: FastifyInstance): void {
    const repository = new StockRepository(scope.pg, scope.config);
    const service = new StockService(repository);
    registerStockRoutes(scope, service);
  },
};

export default stockModule;
