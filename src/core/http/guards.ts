import type { FastifyRequest } from 'fastify';
import { hasScope } from '../auth/principal';
import { Errors } from '../errors/app-error';
import { IDEMPOTENCY_KEY_REGEX } from '../constants';

/**
 * preHandler: require a scope on the resolved principal.
 *
 * `message` exists for panel routes: the default text names an API key, which is nonsense to
 * a human who signed in with a password.
 */
export function requireScope(scope: string, message?: string) {
  return async (req: FastifyRequest): Promise<void> => {
    if (!req.principal || !hasScope(req.principal, scope)) throw Errors.forbidden(message);
  };
}

/**
 * preHandler: require + validate the Idempotency-Key header on a mutation. Missing →
 * IDEMPOTENCY_KEY_REQUIRED; malformed → VALIDATION_ERROR. Stored on req.idempotencyKey.
 */
export function requireIdempotencyKey(action: string) {
  return async (req: FastifyRequest): Promise<void> => {
    const raw = req.headers['idempotency-key'];
    if (typeof raw !== 'string' || raw.length === 0) throw Errors.idempotencyKeyRequired(action);
    if (!IDEMPOTENCY_KEY_REGEX.test(raw)) {
      throw Errors.validation('Idempotency-Key must match ^[A-Za-z0-9_-]{8,128}$.');
    }
    req.idempotencyKey = raw;
  };
}
