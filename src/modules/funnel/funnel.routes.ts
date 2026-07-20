import type { FastifyInstance } from 'fastify';
import { ok } from '../../core/http/envelope';
import { requireScope } from '../../core/http/guards';
import { MAX_FUNNEL_BATCH, MAX_FUNNEL_STEP } from '../../core/constants';
import type { FunnelRepository } from './funnel.repository';
import { GameParams, LogBatchBody, parseBody } from './funnel.schemas';

/**
 * Routes call the repository directly. Mounted by app.ts under /v1/games/:gameId/funnel.
 *
 * Mirrors Roblox's AnalyticsService so game code reads the same on both sides:
 *   LogOnboardingFunnelStepEvent -> kind:"onboarding"
 *   LogFunnelStepEvent           -> kind:"custom" + funnelName + sessionId
 */
export function registerFunnelRoutes(app: FastifyInstance, repo: FunnelRepository): void {
  // POST /log — batched ingest, get-or-create
  app.post(
    '/log',
    {
      // No requireIdempotencyKey, deliberately. The UNIQUE (game, funnel, player, session, step)
      // plus ON CONFLICT DO NOTHING already makes a replayed batch a no-op, so a header here would
      // be one the handler ignores — the same reasoning as stock's /get.
      preHandler: [requireScope('funnel:write')],
      config: {
        docs: {
          group: 'Funnel',
          summary:
            `Log funnel steps in a batch (max ${MAX_FUNNEL_BATCH} events). Creates the funnel and its ` +
            `step names on first call. Mirrors Roblox AnalyticsService: kind:"onboarding" is the one ` +
            `unnamed funnel per game, kind:"custom" is a named funnel (max 10). Steps are 1-${MAX_FUNNEL_STEP}. ` +
            `Retried batches are no-ops, so no Idempotency-Key is needed.`,
          params: { gameId: 'Game identifier (path).' },
          body: LogBatchBody,
          requestExample: {
            funnelName: 'onboarding',
            kind: 'onboarding',
            steps: ['Gain 12 Speed', 'Pickup First Lucky Block', 'Claim First Lucky Block'],
            events: [
              { playerId: 1234567890, step: 1, at: 1784180000 },
              { playerId: 1234567890, step: 2, at: 1784180014, msSincePrev: 14200 },
            ],
          },
          responseExample: {
            funnelName: 'onboarding',
            accepted: 2,
            duplicates: 0,
            dropped: 0,
            runsTouched: 1,
          },
        },
      },
    },
    async (req) => {
      const { gameId } = GameParams.parse(req.params);
      const batch = parseBody(LogBatchBody, req.body);
      return ok(await repo.ingest(gameId, batch, req.principal!.keyId), req.id);
    },
  );

  // GET / — what funnels exist for this game
  app.get(
    '/',
    {
      preHandler: [requireScope('funnel:read')],
      config: {
        docs: {
          group: 'Funnel',
          summary: 'List the funnels registered for a game, with their step count and last event time.',
          params: { gameId: 'Game identifier (path).' },
          responseExample: {
            gameId: 'sword-sim',
            items: [
              {
                funnelName: 'onboarding',
                kind: 'onboarding',
                displayName: null,
                stepCount: 6,
                lastEventAt: '2026-07-20T04:00:00.000Z',
                deletedAt: null,
              },
            ],
          },
        },
      },
    },
    async (req) => {
      const { gameId } = GameParams.parse(req.params);
      return ok({ gameId, items: await repo.list(gameId) }, req.id);
    },
  );
}
