import type { FastifyInstance } from 'fastify';
import { ok } from '../../core/http/envelope';
import { requireIdempotencyKey, requireScope } from '../../core/http/guards';
import { Errors } from '../../core/errors/app-error';
import type { SerialRepository } from '../serial/serial.repository';
import {
  ConfirmBody,
  CreateSerialBody,
  GameParams,
  PanelStockListQuery,
  SerialParams,
  UpdateSerialBody,
  parseBody,
} from './panel.schemas';

/**
 * Serial issuers, from the panel. Same repository the game uses, actor = panel:<userId>.
 *
 * Only `issue` takes an Idempotency-Key, and that asymmetry is deliberate: serial_ledger has no
 * `op` column — it records which NUMBER an event handed out — so a delete or an edit has no
 * honest row to write there (`issued: 0` would read as "issued number 0"). Their audit is
 * deleted_at/deleted_by on the row itself. Every other mutation here is state-guarded instead:
 * a repeated create or delete answers 409, so a double submit cannot double-apply. Requiring a
 * header the handler then ignores would just be a lie about what the endpoint does.
 */
export function registerPanelSerialRoutes(app: FastifyInstance, repo: SerialRepository): void {
  const read = { config: { session: true }, preHandler: [requireScope('panel:read')] };
  const write = { config: { session: true }, preHandler: [requireScope('panel:write')] };
  const issueOpts = {
    config: { session: true },
    preHandler: [requireScope('panel:write'), requireIdempotencyKey('issue')],
  };
  const actor = (req: { panel?: { userId: string } }): string => `panel:${req.panel!.userId}`;

  app.get('/games/:gameId/serial', read, async (req) => {
    const { gameId } = GameParams.parse(req.params);
    const { q, includeDeleted, limit, offset } = PanelStockListQuery.parse(req.query);
    const { items, total } = await repo.list(gameId, limit, offset, includeDeleted);
    const filtered = q ? items.filter((i) => i.serialKey.toLowerCase().includes(q.toLowerCase())) : items;
    return ok({ gameId, total, limit, offset, items: filtered }, req.id);
  });

  app.get('/games/:gameId/serial/:serialKey', read, async (req) => {
    const { gameId, serialKey } = SerialParams.parse(req.params);
    return ok(await repo.read(gameId, serialKey), req.id);
  });

  app.post('/games/:gameId/serial', write, async (req, reply) => {
    const { gameId } = GameParams.parse(req.params);
    const b = parseBody(CreateSerialBody, req.body, 'VALIDATION_ERROR');
    const state = await repo.getOrCreate(
      gameId,
      b.serialKey,
      { start: b.start, max: b.max ?? null, stockKey: b.stockKey ?? null },
      actor(req),
    );
    // getOrCreate is the game's boot call and is intentionally forgiving. From the panel,
    // "create" that silently returned someone else's existing issuer would be a trap.
    if (!state.created) throw Errors.conflict('That serial already exists.', { gameId, serialKey: b.serialKey });
    reply.code(201);
    return ok(state, req.id);
  });

  // `start` and `next` are deliberately not editable: moving either backwards re-issues a
  // number somebody already owns, which is the one thing this module exists to prevent.
  app.patch('/games/:gameId/serial/:serialKey', write, async (req) => {
    const { gameId, serialKey } = SerialParams.parse(req.params);
    const patch = parseBody(UpdateSerialBody, req.body, 'VALIDATION_ERROR');
    return ok(await repo.update(gameId, serialKey, patch, actor(req)), req.id);
  });

  // A game action. Included because an operator genuinely needs it — handing edition #1 to
  // someone, or compensating a bug — and unlike decrease there is no substitute for it.
  app.post('/games/:gameId/serial/:serialKey/issue', issueOpts, async (req) => {
    const { gameId, serialKey } = SerialParams.parse(req.params);
    return ok(await repo.issue(gameId, serialKey, req.idempotencyKey!, actor(req)), req.id);
  });

  app.delete('/games/:gameId/serial/:serialKey', write, async (req) => {
    const { gameId, serialKey } = SerialParams.parse(req.params);
    return ok(await repo.softDelete(gameId, serialKey, actor(req)), req.id);
  });

  app.post('/games/:gameId/serial/:serialKey/restore', write, async (req) => {
    const { gameId, serialKey } = SerialParams.parse(req.params);
    return ok(await repo.restore(gameId, serialKey, actor(req)), req.id);
  });

  app.post(
    '/games/:gameId/serial/:serialKey/purge',
    { config: { session: true }, preHandler: [requireScope('panel:owner', 'Only an owner can purge.')] },
    async (req) => {
      const { gameId, serialKey } = SerialParams.parse(req.params);
      const { confirm } = parseBody(ConfirmBody, req.body, 'VALIDATION_ERROR');
      if (confirm !== serialKey) throw Errors.validation('Type the serial key exactly to confirm.');
      return ok(await repo.purge(gameId, serialKey), req.id);
    },
  );
}
