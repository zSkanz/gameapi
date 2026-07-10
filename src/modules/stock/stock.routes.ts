import type { FastifyInstance } from 'fastify';
import { ok } from '../../core/http/envelope';
import { requireScope, requireIdempotencyKey } from '../../core/http/guards';
import type { StockService } from './stock.service';
import {
  StockParams,
  DecreaseBody,
  AdjustBody,
  GetBody,
  SetMaxBody,
  parseBody,
} from './stock.schemas';

/**
 * Routes are thin: validate → delegate to the service → wrap in the response envelope.
 * Mounted by app.ts under /v1/games/:gameId/stock.
 */
export function registerStockRoutes(app: FastifyInstance, service: StockService): void {
  // POST /:stockKey/decrease
  app.post(
    '/:stockKey/decrease',
    { preHandler: [requireScope('stock:write'), requireIdempotencyKey('decrease')] },
    async (req) => {
      const { gameId, stockKey } = StockParams.parse(req.params);
      const { amount } = parseBody(DecreaseBody, req.body, 'STOCK_INVALID_AMOUNT');
      const result = await service.decrease(gameId, stockKey, amount, req.idempotencyKey!, req.principal!.keyId);
      return ok(result, req.id);
    },
  );

  // POST /:stockKey/adjust
  app.post(
    '/:stockKey/adjust',
    { preHandler: [requireScope('stock:write'), requireIdempotencyKey('adjust')] },
    async (req) => {
      const { gameId, stockKey } = StockParams.parse(req.params);
      const { delta } = parseBody(AdjustBody, req.body, 'STOCK_INVALID_DELTA');
      const result = await service.adjust(gameId, stockKey, delta, req.idempotencyKey!, req.principal!.keyId);
      return ok(result, req.id);
    },
  );

  // POST /:stockKey/get  (get-or-create; no Idempotency-Key — SET NX is naturally idempotent)
  app.post(
    '/:stockKey/get',
    { preHandler: [requireScope('stock:read')] },
    async (req) => {
      const { gameId, stockKey } = StockParams.parse(req.params);
      const { expectedStock } = parseBody(GetBody, req.body, 'STOCK_INVALID_EXPECTED_STOCK');
      const result = await service.get(gameId, stockKey, expectedStock, req.principal!.keyId);
      return ok(result, req.id);
    },
  );

  // POST /:stockKey/set-max
  app.post(
    '/:stockKey/set-max',
    { preHandler: [requireScope('stock:write'), requireIdempotencyKey('set-max')] },
    async (req) => {
      const { gameId, stockKey } = StockParams.parse(req.params);
      const { targetStockMax } = parseBody(SetMaxBody, req.body, 'STOCK_INVALID_TARGET_MAX');
      const result = await service.setMax(gameId, stockKey, targetStockMax, req.idempotencyKey!, req.principal!.keyId);
      return ok(result, req.id);
    },
  );

  // GET /:stockKey  (pure read, no create)
  app.get(
    '/:stockKey',
    { preHandler: [requireScope('stock:read')] },
    async (req) => {
      const { gameId, stockKey } = StockParams.parse(req.params);
      const result = await service.read(gameId, stockKey);
      return ok(result, req.id);
    },
  );
}
