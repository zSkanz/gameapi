import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { AppError } from '../errors/app-error';
import { fail } from '../http/envelope';

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

    // A raw datastore connection/timeout error (e.g. Postgres down) is retriable, not a bug.
    const code = (err as { code?: string }).code;
    if (
      code &&
      ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNRESET', 'EPIPE', '57P01', '57P03', '53300', '08006', '08001'].includes(
        code,
      )
    ) {
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
