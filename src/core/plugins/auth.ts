import type { FastifyInstance } from 'fastify';
import { EnvApiKeyStore } from '../auth/env-store';
import { mayAccessGame } from '../auth/principal';
import { Errors } from '../errors/app-error';

/**
 * API-key authentication. Runs on every non-public route as an onRequest hook (routing
 * is already done here, so req.params.gameId is available). Missing and invalid keys
 * both return an identical 401 (no key-existence oracle).
 */
export async function authPlugin(app: FastifyInstance): Promise<void> {
  app.decorate('apiKeys', new EnvApiKeyStore(app.config.apiKeys));

  app.addHook('onRequest', async (req) => {
    if (req.routeOptions.config?.public) return;

    const raw = req.headers['x-api-key'];
    if (typeof raw !== 'string' || raw.length === 0) throw Errors.unauthenticated();

    const principal = await app.apiKeys.resolve(raw);
    if (!principal) throw Errors.unauthenticated();

    const gameId = (req.params as { gameId?: string } | undefined)?.gameId;
    if (gameId && !mayAccessGame(principal, gameId)) throw Errors.forbidden();

    req.principal = principal;
  });
}
