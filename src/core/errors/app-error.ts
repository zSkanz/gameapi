/**
 * One error taxonomy for the whole API. Error codes are decoupled from HTTP status
 * via CODE_STATUS so a module can add codes without touching transport logic.
 */
export type ErrorCode =
  // ---- generic (reused by every module) ----
  | 'VALIDATION_ERROR' // 400
  | 'IDEMPOTENCY_KEY_REQUIRED' // 400
  | 'IDEMPOTENCY_KEY_REUSED' // 422
  | 'UNAUTHENTICATED' // 401
  | 'FORBIDDEN' // 403
  | 'NOT_FOUND' // 404
  | 'PAYLOAD_TOO_LARGE' // 413
  | 'UNSUPPORTED_MEDIA_TYPE' // 415
  | 'RATE_LIMITED' // 429
  | 'INTERNAL_ERROR' // 500
  | 'SERVICE_UNAVAILABLE' // 503
  // ---- stock module ----
  | 'STOCK_KEY_NOT_FOUND' // 404
  | 'STOCK_INVALID_AMOUNT' // 400
  | 'STOCK_INVALID_DELTA' // 400
  | 'STOCK_INVALID_EXPECTED_STOCK' // 400
  | 'STOCK_INVALID_TARGET_MAX' // 400
  // ---- serial module ----
  | 'SERIAL_NOT_FOUND' // 404
  | 'SERIAL_EXHAUSTED'; // 409

export const CODE_STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  IDEMPOTENCY_KEY_REQUIRED: 400,
  IDEMPOTENCY_KEY_REUSED: 422,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
  STOCK_KEY_NOT_FOUND: 404,
  STOCK_INVALID_AMOUNT: 400,
  STOCK_INVALID_DELTA: 400,
  STOCK_INVALID_EXPECTED_STOCK: 400,
  STOCK_INVALID_TARGET_MAX: 400,
  SERIAL_NOT_FOUND: 404,
  SERIAL_EXHAUSTED: 409,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details?: Record<string, unknown>;
  /** Optional seconds hint for 429/503 responses. */
  readonly retryAfter?: number;

  constructor(
    code: ErrorCode,
    message: string,
    opts: { details?: Record<string, unknown>; retryAfter?: number } = {},
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = CODE_STATUS[code];
    this.details = opts.details;
    this.retryAfter = opts.retryAfter;
  }
}

/** Factory helpers so call sites read cleanly and messages stay consistent. */
export const Errors = {
  validation: (message = 'Request failed validation.', details?: Record<string, unknown>) =>
    new AppError('VALIDATION_ERROR', message, { details }),
  idempotencyKeyRequired: (action: string) =>
    new AppError('IDEMPOTENCY_KEY_REQUIRED', `${action} requires an Idempotency-Key header.`),
  idempotencyKeyReused: () =>
    new AppError(
      'IDEMPOTENCY_KEY_REUSED',
      'This Idempotency-Key was already used for a different request payload.',
    ),
  unauthenticated: () => new AppError('UNAUTHENTICATED', 'Missing or invalid API key.'),
  forbidden: (message = 'This API key is not allowed to perform this action.') =>
    new AppError('FORBIDDEN', message),
  notFound: (message = 'Resource not found.') => new AppError('NOT_FOUND', message),
  rateLimited: (retryAfter: number) =>
    new AppError('RATE_LIMITED', 'Rate limit exceeded.', { retryAfter }),
  unavailable: (message = 'A backing datastore is temporarily unavailable.', retryAfter = 1) =>
    new AppError('SERVICE_UNAVAILABLE', message, { retryAfter }),
  internal: (message = 'Internal error.') => new AppError('INTERNAL_ERROR', message),

  // ---- stock ----
  stockKeyNotFound: (gameId: string, stockKey: string) =>
    new AppError(
      'STOCK_KEY_NOT_FOUND',
      'Stock key has not been initialized. Call /get with expectedStock first.',
      { details: { gameId, stockKey } },
    ),

  // ---- serial ----
  serialNotFound: (gameId: string, serialKey: string) =>
    new AppError('SERIAL_NOT_FOUND', 'Serial has not been initialized. Call /get first.', {
      details: { gameId, serialKey },
    }),
  serialExhausted: (gameId: string, serialKey: string, reason: string) =>
    new AppError('SERIAL_EXHAUSTED', `No more serials can be issued (${reason}).`, {
      details: { gameId, serialKey, reason },
    }),
};
