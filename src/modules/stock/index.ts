import type { FastifyInstance } from 'fastify';
import type { ResourceModule } from '../../core/module';
import { StockRepository } from './stock.repository';
import { registerStockRoutes } from './stock.routes';

/** The stock module. Routes call the repository directly (no passthrough service layer). */
export const stockModule: ResourceModule = {
  name: 'stock',
  register(scope: FastifyInstance): void {
    const repository = new StockRepository(scope.pg, scope.redis, scope.config);
    registerStockRoutes(scope, repository);
  },
};

export default stockModule;
