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
  | 'CONFLICT' // 409
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
  | 'STOCK_KEY_DELETED' // 409
  // ---- serial module ----
  | 'SERIAL_NOT_FOUND' // 404
  | 'SERIAL_EXHAUSTED' // 409
  | 'SERIAL_DELETED' // 409
  // ---- panel ----
  | 'PANEL_SESSION_INVALID' // 401
  | 'PANEL_LOGIN_FAILED' // 401
  | 'PANEL_LOGIN_THROTTLED' // 429
  | 'PANEL_PASSWORD_CHANGE_REQUIRED'; // 403

export const CODE_STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  IDEMPOTENCY_KEY_REQUIRED: 400,
  IDEMPOTENCY_KEY_REUSED: 422,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
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
  STOCK_KEY_DELETED: 409,
  SERIAL_NOT_FOUND: 404,
  SERIAL_EXHAUSTED: 409,
  SERIAL_DELETED: 409,
  PANEL_SESSION_INVALID: 401,
  PANEL_LOGIN_FAILED: 401,
  PANEL_LOGIN_THROTTLED: 429,
  PANEL_PASSWORD_CHANGE_REQUIRED: 403,
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
    opts: { details?: Record<string, unknown>; retryAfter?: number; cause?: unknown } = {},
  ) {
    // `cause` keeps the underlying failure in the logs when a low-level error is translated
    // into an AppError. It is never serialized to the client — only `details` is.
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
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
  conflict: (message: string, details?: Record<string, unknown>) =>
    new AppError('CONFLICT', message, { details }),
  rateLimited: (retryAfter: number) =>
    new AppError('RATE_LIMITED', 'Rate limit exceeded.', { retryAfter }),
  unavailable: (message = 'A backing datastore is temporarily unavailable.', retryAfter = 1, cause?: unknown) =>
    new AppError('SERVICE_UNAVAILABLE', message, { retryAfter, cause }),
  internal: (message = 'Internal error.') => new AppError('INTERNAL_ERROR', message),

  // ---- stock ----
  stockKeyNotFound: (gameId: string, stockKey: string) =>
    new AppError(
      'STOCK_KEY_NOT_FOUND',
      'Stock key has not been initialized. Call /get with expectedStock first.',
      { details: { gameId, stockKey } },
    ),

  /**
   * A write against a soft-deleted key. Never 404: deleting is a control-plane act, so the
   * answer has to say "refused", not "absent" — a 404 here tells the caller to /get with
   * expectedStock, which would refuse again, and that is a retry loop.
   */
  stockKeyDeleted: (gameId: string, stockKey: string) =>
    new AppError(
      'STOCK_KEY_DELETED',
      'Stock key was deleted. Restore it in the panel — a game cannot re-create a deleted key.',
      { details: { gameId, stockKey } },
    ),

  // ---- panel ----
  // Distinct from unauthenticated(), whose message hardcodes "Missing or invalid API key." —
  // wrong and confusing for a cookie-authenticated human.
  panelSessionInvalid: () =>
    new AppError('PANEL_SESSION_INVALID', 'Your session has expired. Sign in again.'),
  /** One message for every cause. Wrong user, wrong password, disabled: all identical. */
  panelLoginFailed: () => new AppError('PANEL_LOGIN_FAILED', 'Incorrect username or password.'),
  panelPasswordChangeRequired: () =>
    new AppError('PANEL_PASSWORD_CHANGE_REQUIRED', 'You must set a new password before continuing.'),

  // ---- serial ----
  serialDeleted: (gameId: string, serialKey: string) =>
    new AppError(
      'SERIAL_DELETED',
      'Serial was deleted. Restore it in the panel — a game cannot re-create a deleted serial.',
      { details: { gameId, serialKey } },
    ),
  serialNotFound: (gameId: string, serialKey: string) =>
    new AppError('SERIAL_NOT_FOUND', 'Serial has not been initialized. Call /get first.', {
      details: { gameId, serialKey },
    }),
  serialExhausted: (gameId: string, serialKey: string, reason: string) =>
    new AppError('SERIAL_EXHAUSTED', `No more serials can be issued (${reason}).`, {
      details: { gameId, serialKey, reason },
    }),
};
