import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { AppError, CODE_STATUS, type ErrorCode } from '../errors/app-error';
import { fail } from '../http/envelope';

/**
 * Postgres SQLSTATEs that describe a client-visible outcome rather than a bug. Without this
 * a lost unique-key race surfaces as an opaque 500, and a statement_timeout (57014, which
 * `statement_timeout: 5000` makes reachable on any large delete) reads as a crash. Messages
 * are deliberately generic — the driver's text carries table and constraint names.
 */
/** Connection-level failures that DO carry a `.code` to match on. */
const OUTAGE_CODES = [
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'ECONNRESET',
  'EPIPE',
  '57P01',
  '57P03',
  '53300',
  '08006',
  '08001',
];

/**
 * Connection failures that arrive with NO `.code` at all — the message is the only signal.
 *
 * Both drivers do this, and it is why a Postgres blip during a stock decrease surfaced as a
 * 500: pg-pool's connect timeout and ioredis' offline-queue rejection are plain Errors.
 * Verified against a real pool with Postgres down. Matched narrowly and only ever to turn a
 * 500 into a retriable 503 — an unrecognized error still surfaces as 500, so real bugs stay
 * loud rather than being masked as "retry later". 'Cannot use a pool after calling end' is
 * deliberately absent: that is a lifecycle bug, not an outage.
 */
const OUTAGE_MESSAGES = [
  'Connection terminated', // pg-pool: connect timeout, or the socket died mid-query
  'timeout exceeded when trying to connect', // pg-pool: pool exhausted / host unreachable
  'Client has encountered a connection error', // pg: client poisoned, not queryable
  "Stream isn't writeable", // ioredis with enableOfflineQueue: false
  'Connection is closed.', // ioredis
];

function looksLikeOutage(err: unknown, code: string | undefined): boolean {
  if (code) return OUTAGE_CODES.includes(code);
  const message = (err as Error)?.message;
  return typeof message === 'string' && OUTAGE_MESSAGES.some((m) => message.includes(m));
}

const PG_OUTCOMES: Record<string, { code: ErrorCode; message: string; retryAfter?: number }> = {
  '23505': { code: 'CONFLICT', message: 'That record already exists.' }, // unique_violation
  '23503': { code: 'VALIDATION_ERROR', message: 'A referenced record does not exist.' }, // foreign_key_violation
  '23514': { code: 'VALIDATION_ERROR', message: 'A value is outside its allowed range.' }, // check_violation
  '22P02': { code: 'VALIDATION_ERROR', message: 'A value has the wrong type.' }, // invalid_text_representation
  '22003': { code: 'VALIDATION_ERROR', message: 'A number is outside its allowed range.' }, // numeric_value_out_of_range
  '57014': { code: 'SERVICE_UNAVAILABLE', message: 'The query took too long. Try again.', retryAfter: 1 }, // statement_timeout
  '55P03': { code: 'SERVICE_UNAVAILABLE', message: 'Someone else is changing this right now. Try again.', retryAfter: 1 }, // lock_not_available (lock_timeout)
  '22P05': { code: 'VALIDATION_ERROR', message: 'A value contains a character that cannot be stored.' }, // untranslatable_character (NUL in jsonb)
  '22021': { code: 'VALIDATION_ERROR', message: 'A value contains a character that cannot be stored.' }, // character_not_in_repertoire (NUL in text)
};

/**
 * Central error mapping. Everything leaves as the standard fail() envelope with a stable
 * error code; internal detail stays in logs. Retry-After is attached for 429/503.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err, req, reply) => {
    const requestId = req.id;

    if (err instanceof AppError) {
      if (err.retryAfter) reply.header('Retry-After', String(err.retryAfter));
      if (err.statusCode >= 500) app.log.error({ err }, 'app error');
      reply
        .code(err.statusCode)
        .send(fail({ code: err.code, message: err.message, details: err.details }, requestId));
      return;
    }

    if (err instanceof ZodError) {
      reply.code(400).send(
        fail(
          { code: 'VALIDATION_ERROR', message: 'Request failed validation.', details: { issues: err.issues } },
          requestId,
        ),
      );
      return;
    }

    // Fastify-native failures (body limit, content-type, built-in schema validation)
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 413) {
      reply.code(413).send(fail({ code: 'PAYLOAD_TOO_LARGE', message: 'Request body too large.' }, requestId));
      return;
    }
    if (status === 415) {
      reply
        .code(415)
        .send(fail({ code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Expected application/json.' }, requestId));
      return;
    }
    if (status === 400) {
      reply.code(400).send(fail({ code: 'VALIDATION_ERROR', message: (err as Error).message }, requestId));
      return;
    }

    const code = (err as { code?: string }).code;

    // A Postgres constraint/timeout outcome — a real answer for the caller, not a crash.
    const pg = code ? PG_OUTCOMES[code] : undefined;
    if (pg) {
      const status = CODE_STATUS[pg.code];
      if (pg.retryAfter) reply.header('Retry-After', String(pg.retryAfter));
      if (status >= 500) app.log.error({ err }, 'postgres outcome');
      else app.log.warn({ err }, 'postgres outcome');
      reply.code(status).send(fail({ code: pg.code, message: pg.message }, requestId));
      return;
    }

    // A raw datastore connection/timeout error (e.g. Postgres down) is retriable, not a bug.
    if (looksLikeOutage(err, code)) {
      app.log.error({ err }, 'datastore unavailable');
      reply.header('Retry-After', '1');
      reply
        .code(503)
        .send(fail({ code: 'SERVICE_UNAVAILABLE', message: 'A backing datastore is temporarily unavailable.' }, requestId));
      return;
    }

    app.log.error({ err }, 'unhandled error');
    reply.code(500).send(fail({ code: 'INTERNAL_ERROR', message: 'Internal error.' }, requestId));
  });

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send(fail({ code: 'NOT_FOUND', message: 'Route not found.' }, req.id));
  });
}
