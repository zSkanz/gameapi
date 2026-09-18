import type { FastifyInstance } from 'fastify';
import { panelActor } from './panel.plugin';
import { z } from 'zod';
import { ok } from '../../core/http/envelope';
import { requireScope } from '../../core/http/guards';
import { Errors } from '../../core/errors/app-error';
import { FUNNEL_NAME_REGEX } from '../../core/constants';
import type { FunnelRepository, Range } from '../funnel/funnel.repository';
import { ConfirmBody, GameParams, parseBody } from './panel.schemas';

const FunnelParams = GameParams.extend({ funnelName: z.string().regex(FUNNEL_NAME_REGEX) });

const FunnelListQuery = z.object({
  includeDeleted: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
});

const DashboardQuery = z.object({
  // 7d, not 30d: AVG TIME at 30 days scans ~5x the rows and starts crossing the 500ms
  // slow-query log line. Thirty days should be a click, not a page load.
  range: z.enum(['1h', '1d', '7d', '30d']).default('7d'),
  /**
   * The viewer's IANA zone. The server runs TZ=UTC but the SPA formats in local time, so daily
   * buckets computed in UTC would put the day boundary at 21:00 for Brazil. Postgres rejects an
   * unknown zone, which the error handler maps to a 400.
   */
  tz: z.string().min(1).max(64).default('UTC'),
  // Roblox's three custom fields, used here as filters — see funnel_run.cf1's column comment.
  cf1: z.string().max(200).optional(),
  cf2: z.string().max(200).optional(),
  cf3: z.string().max(200).optional(),
});

const RenameBody = z.object({ displayName: z.string().min(1).max(120).nullable() }).strict();

/**
 * Funnels, from the panel.
 *
 * Nested under /games/:gameId deliberately: the Discord notifier returns early when a route has no
 * gameId param (webhook.routes.ts), so a funnel route mounted anywhere else would silently never
 * be logged.
 */
export function registerPanelFunnelRoutes(app: FastifyInstance, repo: FunnelRepository): void {
  const read = { config: { session: true }, preHandler: [requireScope('panel:read')] };
  const write = { config: { session: true }, preHandler: [requireScope('panel:write')] };

  app.get('/games/:gameId/funnels', read, async (req) => {
    const { gameId } = GameParams.parse(req.params);
    const { includeDeleted } = FunnelListQuery.parse(req.query);
    return ok({ gameId, items: await repo.list(gameId, includeDeleted) }, req.id);
  });

  app.get('/games/:gameId/funnels/:funnelName', read, async (req) => {
    const { gameId, funnelName } = FunnelParams.parse(req.params);
    const { range, tz, cf1, cf2, cf3 } = DashboardQuery.parse(req.query);
    try {
      return ok(await repo.dashboard(gameId, funnelName, range as Range, tz, { cf1, cf2, cf3 }), req.id);
    } catch (err) {
      // 22023 = invalid_parameter_value, which is what Postgres raises for an unknown time zone.
      // Without this it would surface as a 500 for what is really a bad query param.
      if ((err as { code?: string }).code === '22023') {
        throw Errors.validation(`"${tz}" is not a time zone Postgres recognises.`);
      }
      throw err;
    }
  });

  app.patch('/games/:gameId/funnels/:funnelName', write, async (req) => {
    const { gameId, funnelName } = FunnelParams.parse(req.params);
    const { displayName } = parseBody(RenameBody, req.body);
    return ok(await repo.rename(gameId, funnelName, displayName), req.id);
  });

  // DELETE is the reversible one; purge is a named action below. Same reasoning as stock: putting
  // the irreversible op behind the most reflexive verb in HTTP is how data gets destroyed by a
  // mistyped curl.
  app.delete('/games/:gameId/funnels/:funnelName', write, async (req) => {
    const { gameId, funnelName } = FunnelParams.parse(req.params);
    const r = await repo.softDelete(gameId, funnelName, panelActor(req));
    // Worth saying out loud: unlike a deleted stock key, a deleted funnel makes the game's ingest
    // DROP events rather than re-creating it. Silence would look like the game broke.
    return ok({ gameId, funnelName, ...r, ingestNowDropped: true }, req.id);
  });

  app.post('/games/:gameId/funnels/:funnelName/restore', write, async (req) => {
    const { gameId, funnelName } = FunnelParams.parse(req.params);
    return ok({ gameId, funnelName, ...(await repo.restore(gameId, funnelName)) }, req.id);
  });

  app.post(
    '/games/:gameId/funnels/:funnelName/purge',
    { config: { session: true }, preHandler: [requireScope('panel:owner', 'Only an owner can purge.')] },
    async (req) => {
      const { gameId, funnelName } = FunnelParams.parse(req.params);
      const { confirm } = parseBody(ConfirmBody, req.body);
      if (confirm !== funnelName) throw Errors.validation('Type the funnel name exactly to confirm.');
      return ok({ gameId, funnelName, ...(await repo.purge(gameId, funnelName)) }, req.id);
    },
  );
}
