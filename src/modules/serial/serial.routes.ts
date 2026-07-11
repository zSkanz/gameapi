import type { FastifyInstance } from 'fastify';
import { ok } from '../../core/http/envelope';
import { requireScope, requireIdempotencyKey } from '../../core/http/guards';
import type { SerialRepository } from './serial.repository';
import { SerialParams, SerialGameParams, GetSerialBody, ListQuery, parseBody } from './serial.schemas';

const PARAMS = {
  gameId: 'Game identifier (path).',
  serialKey: 'Serial key within the game (path).',
};

/** Routes call the repository directly. Mounted by app.ts under /v1/games/:gameId/serial. */
export function registerSerialRoutes(app: FastifyInstance, repo: SerialRepository): void {
  // POST /:serialKey/get — get-or-create the issuer
  app.post(
    '/:serialKey/get',
    {
      preHandler: [requireScope('serial:write')],
      config: {
        docs: {
          group: 'Serial',
          summary:
            'Get or create a serial-number issuer. start (default 1); optional max (cap — null/absent = infinite); optional stockKey (each issue also decrements that stock).',
          params: PARAMS,
          body: GetSerialBody,
          requestExample: { start: 1, max: 1000 },
          responseExample: { gameId: 'sword-sim', serialKey: 'excalibur-edition', start: 1, next: 1, max: 1000, stockKey: null, issued: 0, remaining: 1000, created: true },
        },
      },
    },
    async (req) => {
      const { gameId, serialKey } = SerialParams.parse(req.params);
      const b = parseBody(GetSerialBody, req.body, 'VALIDATION_ERROR');
      const state = await repo.getOrCreate(gameId, serialKey, { start: b.start, max: b.max ?? null, stockKey: b.stockKey ?? null }, req.principal!.keyId);
      return ok(state, req.id);
    },
  );

  // POST /:serialKey/issue — issue the next number (atomic, exactly-once)
  app.post(
    '/:serialKey/issue',
    {
      preHandler: [requireScope('serial:write'), requireIdempotencyKey('issue')],
      config: {
        docs: {
          group: 'Serial',
          summary: 'Issue the next serial number atomically (exactly-once). Fails 409 if the max is reached or the linked stock is depleted.',
          idempotency: true,
          params: PARAMS,
          responseExample: { gameId: 'sword-sim', serialKey: 'excalibur-edition', serial: 1, remaining: 999, replayed: false },
        },
      },
    },
    async (req) => {
      const { gameId, serialKey } = SerialParams.parse(req.params);
      return ok(await repo.issue(gameId, serialKey, req.idempotencyKey!, req.principal!.keyId), req.id);
    },
  );

  // GET /:serialKey — read issuer state
  app.get(
    '/:serialKey',
    {
      preHandler: [requireScope('serial:read')],
      config: {
        docs: {
          group: 'Serial',
          summary: 'Read a serial issuer: start, next (peek), max, issued, remaining, linked stockKey.',
          params: PARAMS,
          responseExample: { gameId: 'sword-sim', serialKey: 'excalibur-edition', start: 1, next: 43, max: 1000, stockKey: null, issued: 42, remaining: 958 },
        },
      },
    },
    async (req) => {
      const { gameId, serialKey } = SerialParams.parse(req.params);
      return ok(await repo.read(gameId, serialKey), req.id);
    },
  );

  // GET / — list all serial issuers for the game
  app.get(
    '/',
    {
      preHandler: [requireScope('serial:read')],
      config: {
        docs: {
          group: 'Serial',
          summary: 'List all serial issuers for a game, paginated. Query: ?limit=100&offset=0.',
          params: { gameId: PARAMS.gameId },
          responseExample: {
            gameId: 'sword-sim',
            total: 1,
            limit: 100,
            offset: 0,
            items: [{ serialKey: 'excalibur-edition', start: 1, next: 43, max: 1000, stockKey: null, issued: 42, remaining: 958 }],
          },
        },
      },
    },
    async (req) => {
      const { gameId } = SerialGameParams.parse(req.params);
      const { limit, offset } = ListQuery.parse(req.query);
      const { items, total } = await repo.list(gameId, limit, offset);
      return ok({ gameId, total, limit, offset, items }, req.id);
    },
  );
}
