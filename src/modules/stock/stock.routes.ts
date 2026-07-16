import type { FastifyInstance } from 'fastify';
import { ok } from '../../core/http/envelope';
import { requireScope, requireIdempotencyKey } from '../../core/http/guards';
import type { StockRepository } from './stock.repository';
import {
  StockParams,
  GameParams,
  DecreaseBody,
  AdjustBody,
  GetBody,
  SetMaxBody,
  BatchGetBody,
  ListQuery,
  parseBody,
} from './stock.schemas';

const PARAMS = {
  gameId: 'Game identifier (path).',
  stockKey: 'Stock key within the game (path).',
};

/**
 * Routes call the repository directly: validate -> repository -> response envelope.
 * Each carries `config.docs` metadata that the /docs endpoint renders automatically.
 * Mounted by app.ts under /v1/games/:gameId/stock.
 */
export function registerStockRoutes(app: FastifyInstance, repo: StockRepository): void {
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
          requestExample: { amount: 10 },
          responseExample: { gameId: 'sword-sim', stockKey: 'excalibur', requested: 10, decremented: 5, stock: 0, clamped: true },
        },
      },
    },
    async (req) => {
      const { gameId, stockKey } = StockParams.parse(req.params);
      const { amount } = parseBody(DecreaseBody, req.body, 'STOCK_INVALID_AMOUNT');
      return ok(await repo.decrease(gameId, stockKey, amount, req.idempotencyKey!, req.principal!.keyId), req.id);
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
          requestExample: { delta: 250 },
          responseExample: { gameId: 'sword-sim', stockKey: 'excalibur', delta: 250, applied: 250, stock: 250, max: 1000, clamped: false, capped: false },
        },
      },
    },
    async (req) => {
      const { gameId, stockKey } = StockParams.parse(req.params);
      const { delta } = parseBody(AdjustBody, req.body, 'STOCK_INVALID_DELTA');
      return ok(await repo.adjust(gameId, stockKey, delta, req.idempotencyKey!, req.principal!.keyId), req.id);
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
          requestExample: { expectedStock: 1000 },
          responseExample: { gameId: 'sword-sim', stockKey: 'excalibur', stock: 1000, max: 1000, created: true },
        },
      },
    },
    async (req) => {
      const { gameId, stockKey } = StockParams.parse(req.params);
      const { expectedStock } = parseBody(GetBody, req.body, 'STOCK_INVALID_EXPECTED_STOCK');
      return ok(await repo.get(gameId, stockKey, expectedStock, req.principal!.keyId), req.id);
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
          requestExample: { targetStockMax: 500 },
          responseExample: { gameId: 'sword-sim', stockKey: 'excalibur', max: 500, stock: 500, stockClamped: true },
        },
      },
    },
    async (req) => {
      const { gameId, stockKey } = StockParams.parse(req.params);
      const { targetStockMax } = parseBody(SetMaxBody, req.body, 'STOCK_INVALID_TARGET_MAX');
      return ok(await repo.setMax(gameId, stockKey, targetStockMax, req.idempotencyKey!, req.principal!.keyId), req.id);
    },
  );

  // POST /batch  (read many keys in one request)
  app.post(
    '/batch',
    {
      preHandler: [requireScope('stock:read')],
      config: {
        docs: {
          group: 'Stock',
          summary: 'Read many stock keys in a single request (found in items, unknown keys in missing).',
          params: { gameId: PARAMS.gameId },
          body: BatchGetBody,
          requestExample: { stockKeys: ['excalibur', 'shield'] },
          responseExample: { items: [{ stockKey: 'excalibur', stock: 990, max: 1000 }], missing: ['shield'] },
        },
      },
    },
    async (req) => {
      const { gameId } = GameParams.parse(req.params);
      const { stockKeys } = parseBody(BatchGetBody, req.body);
      return ok(await repo.batchRead(gameId, stockKeys), req.id);
    },
  );

  // GET /  (list all stock keys for the game, paginated)
  app.get(
    '/',
    {
      preHandler: [requireScope('stock:read')],
      config: {
        docs: {
          group: 'Stock',
          summary: 'List all stock keys registered for a game, paginated. Query: ?limit=100&offset=0.',
          params: { gameId: PARAMS.gameId },
          responseExample: {
            gameId: 'sword-sim',
            total: 2,
            limit: 100,
            offset: 0,
            items: [
              { stockKey: 'excalibur', stock: 990, max: 1000 },
              { stockKey: 'shield', stock: 500, max: 500 },
            ],
          },
        },
      },
    },
    async (req) => {
      const { gameId } = GameParams.parse(req.params);
      const { limit, offset } = ListQuery.parse(req.query);
      const { items, total } = await repo.list(gameId, limit, offset);
      // Projected down to the documented game-facing shape. The repository row also carries
      // linkedSerials and deletedAt for the panel; a game-scoped key has no business seeing
      // serial names, and deleted keys are already excluded.
      return ok(
        { gameId, total, limit, offset, items: items.map((i) => ({ stockKey: i.stockKey, stock: i.stock, max: i.max })) },
        req.id,
      );
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
      return ok(await repo.read(gameId, stockKey), req.id);
    },
  );
}
