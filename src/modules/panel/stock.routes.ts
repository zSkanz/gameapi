import type { FastifyInstance } from 'fastify';
import { panelActor } from './panel.plugin';
import { ok } from '../../core/http/envelope';
import { requireIdempotencyKey, requireScope } from '../../core/http/guards';
import { Errors } from '../../core/errors/app-error';
import type { StockRepository } from '../stock/stock.repository';
import {
  AdjustBody,
  ConfirmBody,
  CreateStockBody,
  DecreaseBody,
  GameParams,
  PanelStockListQuery,
  SetMaxBody,
  SetStockBody,
  StockParams,
  parseBody,
} from './panel.schemas';

/**
 * Stock, from the panel.
 *
 * Every mutation goes through the SAME StockRepository the game uses. That is the point: the
 * atomic row-locked writes and the ledger are invariants of that class, and a second write path
 * here would be a second set of them to keep in sync. The actor is `panel:<userId>`, so the
 * ledger attributes the change to a human without a parallel audit table.
 *
 * Guarded by panel:write, never stock:write — stock:write is the scope every Roblox server
 * already holds, and unlike the old wildcard bug that hole would survive the key migration.
 */
export function registerPanelStockRoutes(app: FastifyInstance, repo: StockRepository): void {
  const read = { config: { session: true }, preHandler: [requireScope('panel:read')] };
  const write = (action: string) => ({
    config: { session: true },
    preHandler: [requireScope('panel:write'), requireIdempotencyKey(action)],
  });

  app.get('/games/:gameId/stock', read, async (req) => {
    const { gameId } = GameParams.parse(req.params);
    const { q, includeDeleted, limit, offset } = PanelStockListQuery.parse(req.query);
    const { items, total } = await repo.list(gameId, limit, offset, includeDeleted);
    // Filtered in memory: the page is already bounded at 1000 rows, and pushing ILIKE into the
    // query would cost a second count for `total` to stay honest.
    const filtered = q ? items.filter((i) => i.stockKey.toLowerCase().includes(q.toLowerCase())) : items;
    return ok({ gameId, total, limit, offset, items: filtered }, req.id);
  });

  app.get('/games/:gameId/stock/:stockKey', read, async (req) => {
    const { gameId, stockKey } = StockParams.parse(req.params);
    return ok(await repo.read(gameId, stockKey), req.id);
  });

  app.post('/games/:gameId/stock', write('create'), async (req, reply) => {
    const { gameId } = GameParams.parse(req.params);
    const { stockKey, stock, max } = parseBody(CreateStockBody, req.body, 'VALIDATION_ERROR');
    reply.code(201);
    return ok(await repo.create(gameId, stockKey, stock, max, req.idempotencyKey!, panelActor(req)), req.id);
  });

  app.put('/games/:gameId/stock/:stockKey/stock', write('set-stock'), async (req) => {
    const { gameId, stockKey } = StockParams.parse(req.params);
    const { stock } = parseBody(SetStockBody, req.body, 'VALIDATION_ERROR');
    return ok(await repo.setStock(gameId, stockKey, stock, req.idempotencyKey!, panelActor(req)), req.id);
  });

  app.put('/games/:gameId/stock/:stockKey/max', write('set-max'), async (req) => {
    const { gameId, stockKey } = StockParams.parse(req.params);
    const { max } = parseBody(SetMaxBody, req.body, 'VALIDATION_ERROR');
    return ok(await repo.setMax(gameId, stockKey, max, req.idempotencyKey!, panelActor(req)), req.id);
  });

  app.post('/games/:gameId/stock/:stockKey/adjust', write('adjust'), async (req) => {
    const { gameId, stockKey } = StockParams.parse(req.params);
    const { delta } = parseBody(AdjustBody, req.body, 'VALIDATION_ERROR');
    return ok(await repo.adjust(gameId, stockKey, delta, req.idempotencyKey!, panelActor(req)), req.id);
  });

  // A game action, exposed here because the panel must cover everything the API can do. adjust
  // with a negative delta is close but not identical: this reports requested/decremented/clamped.
  app.post('/games/:gameId/stock/:stockKey/decrease', write('decrease'), async (req) => {
    const { gameId, stockKey } = StockParams.parse(req.params);
    const { amount } = parseBody(DecreaseBody, req.body, 'VALIDATION_ERROR');
    return ok(await repo.decrease(gameId, stockKey, amount, req.idempotencyKey!, panelActor(req)), req.id);
  });

  // DELETE is the reversible one. The irreversible op is a named action below — putting purge
  // behind the most reflexive verb in HTTP is how a ledger gets destroyed by a mistyped curl.
  app.delete('/games/:gameId/stock/:stockKey', write('delete'), async (req) => {
    const { gameId, stockKey } = StockParams.parse(req.params);
    return ok(await repo.softDelete(gameId, stockKey, req.idempotencyKey!, panelActor(req)), req.id);
  });

  app.post('/games/:gameId/stock/:stockKey/restore', write('restore'), async (req) => {
    const { gameId, stockKey } = StockParams.parse(req.params);
    return ok(await repo.restore(gameId, stockKey, req.idempotencyKey!, panelActor(req)), req.id);
  });

  // Owner-only. No Idempotency-Key: the ledger rows it would be written into are the ones
  // being deleted. It requires a prior soft delete, which is the real safeguard — by the time
  // anything is destroyed the key has been refusing every game server since the first click.
  app.post(
    '/games/:gameId/stock/:stockKey/purge',
    { config: { session: true }, preHandler: [requireScope('panel:owner', 'Only an owner can purge.')] },
    async (req) => {
      const { gameId, stockKey } = StockParams.parse(req.params);
      const { confirm } = parseBody(ConfirmBody, req.body, 'VALIDATION_ERROR');
      if (confirm !== stockKey) throw Errors.validation('Type the stock key exactly to confirm.');
      return ok(await repo.purge(gameId, stockKey, panelActor(req)), req.id);
    },
  );
}
