import type { FastifyInstance } from 'fastify';
import { readSessionCookie } from '../auth/cookie';
import { DbApiKeyStore } from '../auth/db-store';
import { EnvApiKeyStore } from '../auth/env-store';
import { mayAccessGame, principalFor } from '../auth/principal';
import { PanelSessions } from '../auth/session';
import { Errors } from '../errors/app-error';

/**
 * Authentication. Runs on every non-public route as an onRequest hook (routing is already
 * done here, so req.params.gameId is available). Missing and invalid credentials both return
 * an identical 401 — no existence oracle.
 *
 * Two credential paths, one hook: games present `x-api-key`, the panel presents a session
 * cookie. Deliberately not a second root hook — this way "principal is resolved before the
 * rate limiter runs" stays structural instead of an ordering comment in app.ts, and a route
 * that forgets to declare `session` falls into the api-key path, where the panel gate then
 * refuses it. Both directions fail closed.
 */
export async function authPlugin(app: FastifyInstance): Promise<void> {
  // Two stores, no Composite wrapper: the formats are mutually exclusive by construction
  // (the env store cannot match a `gk_<id>.<secret>`, and the DB store rejects anything that
  // is not that shape), so the fallback is one `??` rather than a passthrough layer.
  //
  // Env FIRST, deliberately: the bootstrap key is a fixed-size digest scan with no query, so
  // it keeps working during a Postgres outage — which is exactly when you need it.
  const bootstrap =
    app.config.env.BOOTSTRAP_API_KEY_ENABLED && app.config.apiKeys.length > 0
      ? new EnvApiKeyStore(app.config.apiKeys)
      : null;
  if (!bootstrap) app.log.info('bootstrap api key disabled — per-game keys only');
  const db = new DbApiKeyStore(app.pg);

  app.decorate('apiKeys', {
    resolve: async (raw: string) => (await bootstrap?.resolve(raw)) ?? db.resolve(raw),
  });

  const { env } = app.config;
  const sessions = new PanelSessions(
    app.redis,
    env.REDIS_KEY_PREFIX,
    env.PANEL_SESSION_IDLE_MINUTES * 60,
    env.PANEL_SESSION_ABSOLUTE_HOURS * 3600,
  );
  app.decorate('panelSessions', sessions);

  app.addHook('onRequest', async (req) => {
    if (req.routeOptions.config?.public) return;

    // ---- panel: session cookie, never x-api-key ----
    const mode = req.routeOptions.config?.session;
    if (mode) {
      const rawCookie = readSessionCookie(req.headers.cookie);
      const sess = rawCookie ? await sessions.resolve(rawCookie) : null;
      if (!sess) {
        if (mode === 'anon') return; // login/logout: no session yet, and that is fine
        throw Errors.panelSessionInvalid();
      }
      req.panel = sess;
      req.principal = principalFor(sess); // unlocks requireScope and the rate limiter
      return;
    }

    // ---- games: x-api-key ----
    const raw = req.headers['x-api-key'];
    if (typeof raw !== 'string' || raw.length === 0) throw Errors.unauthenticated();

    const principal = await app.apiKeys.resolve(raw);
    if (!principal) throw Errors.unauthenticated();

    const gameId = (req.params as { gameId?: string } | undefined)?.gameId;
    if (gameId && !mayAccessGame(principal, gameId)) throw Errors.forbidden();

    req.principal = principal;
  });
}
