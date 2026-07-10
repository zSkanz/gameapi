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

const PARAMS = {
  gameId: 'Game identifier (path).',
  stockKey: 'Stock key within the game (path).',
};

/**
 * Routes are thin: validate -> delegate to the service -> wrap in the response envelope.
 * Each carries `config.docs` metadata that the /docs endpoint renders automatically.
 * Mounted by app.ts under /v1/games/:gameId/stock.
 */
export function registerStockRoutes(app: FastifyInstance, service: StockService): void {
  // POST /:stockKey/decrease
  app.post(
    '/:stockKey/decrease',
    {
      preHandler: [requireScope('stock:write'), requireIdempotencyKey('decrease')],
      config: {
        docs: {
          group: 'Stock',
          summary: 'Atomically subtract from stock, clamped at 0. Reports how much was actually applied.',
          idempotency: true,
          params: PARAMS,
          body: DecreaseBody,
          responseExample: { gameId: 'sword-sim', stockKey: 'excalibur', requested: 10, decremented: 5, stock: 0, clamped: true },
        },
      },
    },
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
    {
      preHandler: [requireScope('stock:write'), requireIdempotencyKey('adjust')],
      config: {
        docs: {
          group: 'Stock',
          summary: 'Apply a signed delta. Clamps at 0 (floor) and at the per-record max (ceiling).',
          idempotency: true,
          params: PARAMS,
          body: AdjustBody,
          responseExample: { gameId: 'sword-sim', stockKey: 'excalibur', delta: 250, applied: 250, stock: 250, max: 1000, clamped: false, capped: false },
        },
      },
    },
    async (req) => {
      const { gameId, stockKey } = StockParams.parse(req.params);
      const { delta } = parseBody(AdjustBody, req.body, 'STOCK_INVALID_DELTA');
      const result = await service.adjust(gameId, stockKey, delta, req.idempotencyKey!, req.principal!.keyId);
      return ok(result, req.id);
    },
  );

  // POST /:stockKey/get  (get-or-create; no Idempotency-Key — creation is naturally idempotent)
  app.post(
    '/:stockKey/get',
    {
      preHandler: [requireScope('stock:read')],
      config: {
        docs: {
          group: 'Stock',
          summary: 'Get current stock; get-or-create seeding both stock and max from expectedStock when the key is missing.',
          params: PARAMS,
          body: GetBody,
          responseExample: { gameId: 'sword-sim', stockKey: 'excalibur', stock: 1000, max: 1000, created: true },
        },
      },
    },
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
    {
      preHandler: [requireScope('stock:write'), requireIdempotencyKey('set-max')],
      config: {
        docs: {
          group: 'Stock',
          summary: 'Set the per-record ceiling. Lowering it clamps current stock down; raising it never refills.',
          idempotency: true,
          params: PARAMS,
          body: SetMaxBody,
          responseExample: { gameId: 'sword-sim', stockKey: 'excalibur', max: 500, stock: 500, stockClamped: true },
        },
      },
    },
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
    {
      preHandler: [requireScope('stock:read')],
      config: {
        docs: {
          group: 'Stock',
          summary: 'Read current stock and max (no create).',
          params: PARAMS,
          responseExample: { gameId: 'sword-sim', stockKey: 'excalibur', stock: 990, max: 1000 },
        },
      },
    },
    async (req) => {
      const { gameId, stockKey } = StockParams.parse(req.params);
      const result = await service.read(gameId, stockKey);
      return ok(result, req.id);
    },
  );
}
