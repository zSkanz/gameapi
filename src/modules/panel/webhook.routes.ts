import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ok } from '../../core/http/envelope';
import { requireScope } from '../../core/http/guards';
import { Errors } from '../../core/errors/app-error';
import { GameParams, parseBody } from './panel.schemas';
import { assertSafeWebhookUrl, deliver, describeAction, findWebhook, maskWebhookUrl } from './webhook';

const SetWebhookBody = z
  .object({ url: z.string().min(1).max(500), enabled: z.boolean().default(true) })
  .strict();

/** Never returns `url` — the URL is a bearer credential, so it goes in and never comes back. */
function view(row: Record<string, unknown> | undefined) {
  if (!row) return null;
  return {
    url: maskWebhookUrl(row.url as string),
    enabled: row.enabled as boolean,
    lastStatus: row.last_status === null ? null : Number(row.last_status),
    lastError: (row.last_error as string | null) ?? null,
    lastOkAt: row.last_ok_at ? (row.last_ok_at as Date).toISOString() : null,
    lastAttemptAt: row.last_attempt_at ? (row.last_attempt_at as Date).toISOString() : null,
    createdBy: (row.created_by as string | null) ?? null,
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}

const COLS = `game_id, url, enabled, last_status, last_error, last_ok_at, last_attempt_at, created_by, updated_at`;

export function registerPanelWebhookRoutes(app: FastifyInstance): void {
  const owner = (what: string) => ({
    config: { session: true },
    preHandler: [requireScope('panel:owner', `Only an owner can ${what} the webhook.`)],
  });

  app.get('/games/:gameId/webhook', { config: { session: true }, preHandler: [requireScope('panel:read')] }, async (req) => {
    const { gameId } = GameParams.parse(req.params);
    const r = await app.pg.query(`SELECT ${COLS} FROM game_webhook WHERE game_id = $1`, [gameId]);
    return ok({ gameId, webhook: view(r.rows[0]) }, req.id);
  });

  app.put('/games/:gameId/webhook', owner('change'), async (req) => {
    const { gameId } = GameParams.parse(req.params);
    const { url, enabled } = parseBody(SetWebhookBody, req.body);
    // Checked before it is stored, not before every send: a save is rare, a send is per action.
    await assertSafeWebhookUrl(url);

    const r = await app.pg.query(
      `INSERT INTO game_webhook (game_id, url, enabled, created_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (game_id) DO UPDATE
         SET url = EXCLUDED.url, enabled = EXCLUDED.enabled, updated_at = now(),
             last_status = NULL, last_error = NULL, last_attempt_at = NULL
       RETURNING ${COLS}`,
      [gameId, url, enabled, `panel:${req.panel!.userId}`],
    );
    return ok({ gameId, webhook: view(r.rows[0]) }, req.id);
  });

  app.delete('/games/:gameId/webhook', owner('remove'), async (req) => {
    const { gameId } = GameParams.parse(req.params);
    const r = await app.pg.query(`DELETE FROM game_webhook WHERE game_id = $1 RETURNING game_id`, [gameId]);
    if (r.rowCount === 0) throw Errors.notFound('No webhook is configured for this game.');
    return ok({ gameId, removed: true }, req.id);
  });

  /**
   * Send a test message. Awaited, unlike real deliveries — the whole point is to find out
   * whether it works, so the result has to come back.
   */
  app.post('/games/:gameId/webhook/test', owner('test'), async (req) => {
    const { gameId } = GameParams.parse(req.params);
    const hook = await findWebhook(app.pg, gameId);
    if (!hook) throw Errors.notFound('No webhook is configured, or it is switched off.');

    await deliver(app.pg, app.log, hook, {
      username: req.panel!.username,
      role: req.panel!.role,
      gameId,
      action: { emoji: '🔔', text: 'sent a test message — the webhook is connected', colour: 0x5865f2 },
      ip: req.ip,
    });

    const r = await app.pg.query(`SELECT ${COLS} FROM game_webhook WHERE game_id = $1`, [gameId]);
    const w = view(r.rows[0]);
    // The status is reported, but never the response body: echoing what an arbitrary https URL
    // replied would turn this endpoint into a network scanner for whoever holds a panel account.
    return ok({ gameId, delivered: w?.lastError === null, webhook: w }, req.id);
  });
}

/**
 * Fire the webhook for panel mutations. One hook on the /v1/panel scope, so a new route is
 * logged the day it ships instead of the day someone remembers to add a call.
 *
 * Placed in onResponse: the status code is known, the response is already on its way to the
 * browser, and nothing here can delay or fail the action it describes.
 */
export function registerWebhookNotifier(scope: FastifyInstance): void {
  scope.addHook('onResponse', async (req, reply) => {
    // Only human actions. `req.panel` is set by the cookie branch of the auth hook and nothing
    // else — this is exactly the "not the API, just what a person did" filter.
    if (!req.panel) return;
    if (req.method === 'GET' || req.method === 'HEAD') return;
    if (reply.statusCode >= 300) return; // a refused action is not an action
    const routeUrl = req.routeOptions.url ?? '';
    // Their bodies hold passwords, and they are not game-scoped anyway.
    if (routeUrl.includes('/auth/')) return;

    const gameId = (req.params as { gameId?: string } | undefined)?.gameId;
    if (!gameId) return; // account admin is not a per-game event

    // Deliberately not awaited: onResponse still holds the request alive, and a slow Discord
    // must not pin a connection. Errors are handled inside deliver().
    void (async () => {
      try {
        const hook = await findWebhook(scope.pg, gameId);
        if (!hook) return;
        const action = describeAction({
          method: req.method,
          routeUrl,
          params: (req.params ?? {}) as Record<string, string | undefined>,
          body: req.body,
        });
        if (!action) return;
        await deliver(scope.pg, scope.log, hook, {
          username: req.panel!.username,
          role: req.panel!.role,
          gameId,
          action,
          ip: req.ip,
        });
      } catch (err) {
        scope.log.warn({ err, gameId }, 'webhook notify failed');
      }
    })();
  });
}
