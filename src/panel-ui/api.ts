/**
 * The one door to /v1/panel. Every screen goes through here, which is what makes the
 * session-expiry bounce and the must-change-password trap impossible to forget at a call site.
 */

const BASE = '/v1/panel';

export type Role = 'owner' | 'admin';

export interface Session {
  userId: string;
  username: string;
  role: Role;
  mustChangePassword: boolean;
}

export interface Meta {
  requestId: string;
  timestamp: string;
}

type Envelope<T> =
  | { ok: true; data: T; meta: Meta }
  | { ok: false; error: { code: string; message: string; details?: Record<string, unknown> }; meta: Meta };

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;
  /** Seconds. Only ever present on 429/503. */
  readonly retryAfter: number | undefined;

  constructor(
    code: string,
    message: string,
    status: number,
    details?: Record<string, unknown>,
    retryAfter?: number,
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
    this.retryAfter = retryAfter;
  }
}

/** Pull `linkedSerials` etc. off an error without every call site casting `unknown`. */
export function detailList(err: unknown, key: string): string[] {
  if (!(err instanceof ApiError)) return [];
  const v = err.details?.[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

export function isApiError(err: unknown, ...codes: string[]): err is ApiError {
  return err instanceof ApiError && (codes.length === 0 || codes.includes(err.code));
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Something went wrong.';
}

// ---- centralized session handling ----
// Set once, by AuthProvider. Kept as module state rather than threaded through every call so a
// 401 can never be handled "everywhere except that one screen".
let onSessionInvalid: (() => void) | null = null;
let onPasswordChangeRequired: (() => void) | null = null;

export function setSessionHandlers(handlers: {
  sessionInvalid: () => void;
  passwordChangeRequired: () => void;
}): void {
  onSessionInvalid = handlers.sessionInvalid;
  onPasswordChangeRequired = handlers.passwordChangeRequired;
}

interface RequestOptions {
  body?: unknown;
  /**
   * Minted when a dialog OPENS, never per click — see newIdempotencyKey(). Reusing it is the
   * entire point: /adjust takes a signed delta, so a double-submit without it double-applies.
   */
  idempotencyKey?: string;
  signal?: AbortSignal;
  query?: Record<string, string | number | boolean | undefined>;
}

function withQuery(path: string, query: RequestOptions['query']): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== '') params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;

  let res: Response;
  try {
    res = await fetch(BASE + withQuery(path, opts.query), {
      method,
      headers,
      // The __Host- session cookie is the credential and the SPA is served from the same
      // origin as the API, so this is all the auth there is.
      credentials: 'same-origin',
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError('NETWORK_ERROR', 'Could not reach the server. Check your connection.', 0);
  }

  let payload: unknown = null;
  try {
    payload = await res.json();
  } catch {
    /* a proxy error page, or 204 — handled below */
  }

  const env = payload as Envelope<T> | null;
  if (res.ok && env && env.ok === true) return env.data;

  const failed = env && env.ok === false ? env.error : null;
  const code = failed?.code ?? 'INTERNAL_ERROR';
  const message = failed?.message ?? `Request failed (${res.status}).`;

  // AppError.retryAfter never reaches the body: the fail() envelope serializes only
  // {code,message,details}, and the error handler puts the value in a header. Read it there,
  // and let details win if a future route ever does include it.
  const detailRetry = failed?.details?.['retryAfter'];
  const header = Number(res.headers.get('retry-after'));
  const retryAfter =
    typeof detailRetry === 'number' ? detailRetry : Number.isFinite(header) && header > 0 ? header : undefined;

  const error = new ApiError(code, message, res.status, failed?.details, retryAfter);

  // The bounce, in exactly one place. Gated on the CODE and not on status 401, because
  // PANEL_LOGIN_FAILED is also a 401 and bouncing the login page to the login page would
  // wipe the "Incorrect username or password" the user needs to read.
  if (code === 'PANEL_SESSION_INVALID') onSessionInvalid?.();
  if (code === 'PANEL_PASSWORD_CHANGE_REQUIRED') onPasswordChangeRequired?.();

  throw error;
}

/** One per dialog-open. crypto.randomUUID needs a secure context; /panel is always HTTPS. */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

// ---- auth ----
export const api = {
  login: (username: string, password: string) =>
    request<Session>('POST', '/auth/login', { body: { username, password } }),
  logout: () => request<{ signedOut: true }>('POST', '/auth/logout'),
  me: (signal?: AbortSignal) => request<Session>('GET', '/auth/me', signal ? { signal } : {}),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<Session>('POST', '/auth/password', { body: { currentPassword, newPassword } }),

  // ---- users (owner) ----
  listUsers: (signal?: AbortSignal) => request<{ items: User[] }>('GET', '/users', signal ? { signal } : {}),
  createUser: (username: string, role: Role) =>
    request<{ user: User; password: string }>('POST', '/users', { body: { username, role } }),
  updateUser: (userId: string, patch: { role?: Role; disabled?: boolean }) =>
    request<User>('PATCH', `/users/${encodeURIComponent(userId)}`, { body: patch }),
  resetUserPassword: (userId: string) =>
    request<{ password: string }>('POST', `/users/${encodeURIComponent(userId)}/password`),

  // ---- games ----
  listGames: (query: ListQuery & { includeDeleted?: boolean }, signal?: AbortSignal) =>
    request<Paged<Game>>('GET', '/games', { query, ...(signal ? { signal } : {}) }),
  getGame: (gameId: string, signal?: AbortSignal) =>
    request<Game>('GET', game(gameId), { ...(signal ? { signal } : {}) }),
  createGame: (body: { gameId: string; name: string; maxKeys: number }) =>
    request<Game>('POST', '/games', { body }),
  deleteGame: (gameId: string) =>
    request<{ gameId: string; deletedAt: string; keysDisabled: number; effectiveWithinSeconds: number }>(
      'DELETE',
      game(gameId),
    ),
  restoreGame: (gameId: string) => request<{ gameId: string; restored: boolean }>('POST', `${game(gameId)}/restore`),

  // ---- api keys ----
  listKeys: (gameId: string, query: { includeRevoked?: boolean; limit: number; offset: number }, signal?: AbortSignal) =>
    request<Paged<ApiKey>>('GET', `${game(gameId)}/keys`, { query, ...(signal ? { signal } : {}) }),
  createKey: (gameId: string, body: { label: string; scopes: Scope[] }) =>
    request<{ key: ApiKey; fullKey: string }>('POST', `${game(gameId)}/keys`, { body }),
  revokeKey: (gameId: string, keyId: string) =>
    request<ApiKey>('POST', `${game(gameId)}/keys/${encodeURIComponent(keyId)}/revoke`),

  // ---- discord webhook ----
  getWebhook: (gameId: string, signal?: AbortSignal) =>
    request<{ gameId: string; webhook: Webhook | null }>('GET', `${game(gameId)}/webhook`, {
      ...(signal ? { signal } : {}),
    }),
  setWebhook: (gameId: string, body: { url: string; enabled: boolean }) =>
    request<{ gameId: string; webhook: Webhook }>('PUT', `${game(gameId)}/webhook`, { body }),
  removeWebhook: (gameId: string) => request<{ removed: boolean }>('DELETE', `${game(gameId)}/webhook`),
  testWebhook: (gameId: string) =>
    request<{ delivered: boolean; webhook: Webhook | null }>('POST', `${game(gameId)}/webhook/test`),

  // ---- roblox open cloud ----
  getRoblox: (gameId: string, signal?: AbortSignal) =>
    request<{ gameId: string; roblox: RobloxLink | null }>('GET', `${game(gameId)}/roblox`, {
      ...(signal ? { signal } : {}),
    }),
  setRoblox: (gameId: string, body: { universeId: string; apiKey: string }) =>
    request<{ gameId: string; roblox: RobloxLink }>('PUT', `${game(gameId)}/roblox`, { body }),
  removeRoblox: (gameId: string) => request<{ removed: boolean }>('DELETE', `${game(gameId)}/roblox`),
  publishToRoblox: (gameId: string, body: { topic: string; message: string }) =>
    request<{ topic: string; delivered: boolean; api: string | null }>('POST', `${game(gameId)}/roblox/publish`, {
      body,
    }),

  // ---- stock ----
  listStock: (gameId: string, query: ListQuery & { includeDeleted?: boolean }, signal?: AbortSignal) =>
    request<Paged<StockRow>>('GET', `${game(gameId)}/stock`, { query, ...(signal ? { signal } : {}) }),
  createStock: (gameId: string, body: { stockKey: string; stock: number; max: number }, idempotencyKey: string) =>
    request<StockRow>('POST', `${game(gameId)}/stock`, { body, idempotencyKey }),
  setStock: (gameId: string, stockKey: string, stock: number, idempotencyKey: string) =>
    request<StockRow>('PUT', `${stock_(gameId, stockKey)}/stock`, { body: { stock }, idempotencyKey }),
  setMax: (gameId: string, stockKey: string, max: number, idempotencyKey: string) =>
    request<StockRow>('PUT', `${stock_(gameId, stockKey)}/max`, { body: { max }, idempotencyKey }),
  adjustStock: (gameId: string, stockKey: string, delta: number, idempotencyKey: string) =>
    request<StockRow>('POST', `${stock_(gameId, stockKey)}/adjust`, { body: { delta }, idempotencyKey }),
  decreaseStock: (gameId: string, stockKey: string, amount: number, idempotencyKey: string) =>
    request<StockRow>('POST', `${stock_(gameId, stockKey)}/decrease`, { body: { amount }, idempotencyKey }),
  deleteStock: (gameId: string, stockKey: string, idempotencyKey: string) =>
    request<{ deletedAt: string; linkedSerials: string[] }>('DELETE', stock_(gameId, stockKey), { idempotencyKey }),
  restoreStock: (gameId: string, stockKey: string, idempotencyKey: string) =>
    request<StockRow>('POST', `${stock_(gameId, stockKey)}/restore`, { idempotencyKey }),
  purgeStock: (gameId: string, stockKey: string, confirm: string) =>
    request<{ ledgerRowsDeleted: number; severedSerials: string[] }>('POST', `${stock_(gameId, stockKey)}/purge`, {
      body: { confirm },
    }),

  // ---- serial ----
  listSerial: (gameId: string, query: ListQuery & { includeDeleted?: boolean }, signal?: AbortSignal) =>
    request<Paged<SerialRow>>('GET', `${game(gameId)}/serial`, { query, ...(signal ? { signal } : {}) }),
  createSerial: (
    gameId: string,
    body: { serialKey: string; start: number; max?: number | null; stockKey?: string | null },
    idempotencyKey: string,
  ) => request<SerialRow>('POST', `${game(gameId)}/serial`, { body, idempotencyKey }),
  updateSerial: (
    gameId: string,
    serialKey: string,
    body: { max?: number | null; stockKey?: string | null },
    idempotencyKey: string,
  ) => request<SerialRow>('PATCH', serial_(gameId, serialKey), { body, idempotencyKey }),
  issueSerial: (gameId: string, serialKey: string, idempotencyKey: string) =>
    request<{ serial: number; remaining: number | null; replayed: boolean }>(`POST`, `${serial_(gameId, serialKey)}/issue`, {
      idempotencyKey,
    }),
  deleteSerial: (gameId: string, serialKey: string, idempotencyKey: string) =>
    request<{ deletedAt: string }>('DELETE', serial_(gameId, serialKey), { idempotencyKey }),
  restoreSerial: (gameId: string, serialKey: string, idempotencyKey: string) =>
    request<SerialRow>('POST', `${serial_(gameId, serialKey)}/restore`, { idempotencyKey }),
  purgeSerial: (gameId: string, serialKey: string, confirm: string) =>
    request<{ severedSerials?: string[] }>('POST', `${serial_(gameId, serialKey)}/purge`, { body: { confirm } }),

  // ---- funnels ----
  // No Idempotency-Key on any of these: they are reads, or state-setting writes (deleted_at
  // := now/NULL, or a hard delete) where a replay lands on the same state by construction.
  listFunnels: (gameId: string, query: { includeDeleted?: boolean }, signal?: AbortSignal) =>
    request<{ gameId: string; items: FunnelRow[] }>('GET', `${game(gameId)}/funnels`, {
      query,
      ...(signal ? { signal } : {}),
    }),
  getFunnel: (gameId: string, funnelName: string, query: FunnelQuery, signal?: AbortSignal) =>
    request<FunnelReport>('GET', funnel_(gameId, funnelName), { query, ...(signal ? { signal } : {}) }),
  updateFunnel: (gameId: string, funnelName: string, body: { displayName: string | null }) =>
    request<FunnelRow>('PATCH', funnel_(gameId, funnelName), { body }),
  deleteFunnel: (gameId: string, funnelName: string) =>
    request<{ deletedAt: string }>('DELETE', funnel_(gameId, funnelName)),
  restoreFunnel: (gameId: string, funnelName: string) =>
    request<FunnelRow>('POST', `${funnel_(gameId, funnelName)}/restore`),
  purgeFunnel: (gameId: string, funnelName: string, confirm: string) =>
    request<{ eventsDeleted: number; runsDeleted: number }>('POST', `${funnel_(gameId, funnelName)}/purge`, {
      body: { confirm },
    }),
};

// gameId/stockKey charsets permit ':' and '.', which are legal in a path segment but must not
// be able to smuggle a '/' or a '?'.
const game = (gameId: string) => `/games/${encodeURIComponent(gameId)}`;
const stock_ = (gameId: string, stockKey: string) => `${game(gameId)}/stock/${encodeURIComponent(stockKey)}`;
const serial_ = (gameId: string, serialKey: string) => `${game(gameId)}/serial/${encodeURIComponent(serialKey)}`;
const funnel_ = (gameId: string, funnelName: string) => `${game(gameId)}/funnels/${encodeURIComponent(funnelName)}`;

// ---- shapes ----
// A type alias, not an interface, on purpose: only aliases get an implicit index signature, so
// only these satisfy the Record<string, …> that withQuery() takes.
export type ListQuery = {
  q?: string;
  limit: number;
  offset: number;
};

export interface Paged<T> {
  total: number;
  limit?: number;
  offset?: number;
  items: T[];
}

export interface User {
  userId: string;
  username: string;
  role: Role;
  disabledAt: string | null;
  mustChangePassword: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface Game {
  gameId: string;
  name: string;
  status: string;
  maxKeys: number;
  createdAt: string;
  /** Set = the game is deleted: its API keys stop authenticating, nothing is destroyed. */
  deletedAt: string | null;
  stockKeys: number;
  serialKeys: number;
  activeKeys: number;
  funnels: number;
}

export type Scope =
  | 'stock:read'
  | 'stock:write'
  | 'serial:read'
  | 'serial:write'
  | 'funnel:read'
  | 'funnel:write';

/** Roblox's own documented caps — ours must match or we send requests that cannot succeed. */
export const ROBLOX_TOPIC_MAX = 80;
export const ROBLOX_MESSAGE_MAX = 1024;

export interface RobloxLink {
  universeId: string;
  /** The Open Cloud API key is never sent back — it can publish to a real experience. */
  lastStatus: number | null;
  lastError: string | null;
  /** Which Open Cloud version actually worked: v2 is documented-but-beta, v1 is the fallback. */
  lastApi: string | null;
  lastOkAt: string | null;
  lastAttemptAt: string | null;
  createdBy: string | null;
  updatedAt: string;
}

export interface Webhook {
  /** Masked to its origin — the server never sends the real URL back, it is a bearer secret. */
  url: string;
  enabled: boolean;
  lastStatus: number | null;
  lastError: string | null;
  lastOkAt: string | null;
  lastAttemptAt: string | null;
  createdBy: string | null;
  updatedAt: string;
}

export const ALL_SCOPES: Scope[] = [
  'stock:read',
  'stock:write',
  'serial:read',
  'serial:write',
  'funnel:read',
  'funnel:write',
];

export interface ApiKey {
  keyId: string;
  label: string;
  scopes: Scope[];
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdBy: string | null;
}

export interface StockRow {
  stockKey: string;
  stock: number;
  max: number;
  linkedSerials: string[];
  deletedAt: string | null;
}

export interface SerialRow {
  serialKey: string;
  start: number;
  next: number;
  max: number | null;
  stockKey: string | null;
  issued: number;
  remaining: number | null;
  deletedAt: string | null;
}

// ---- funnels ----
export type FunnelRange = '1h' | '1d' | '7d' | '30d';

/** Roblox's two funnel flavours: one unnamed onboarding funnel per game, plus named customs. */
export type FunnelKind = 'onboarding' | 'custom';

// A type alias for the same reason ListQuery is one — withQuery() takes a Record, and only
// aliases get the implicit index signature that satisfies it. An interface here fails to compile.
export type FunnelQuery = {
  range: FunnelRange;
  /** IANA zone. Day buckets are cut in the viewer's timezone, server-side. */
  tz: string;
  cf1?: string;
  cf2?: string;
  cf3?: string;
};

export interface FunnelRow {
  funnelName: string;
  kind: FunnelKind;
  displayName: string | null;
  stepCount: number;
  lastEventAt: string | null;
  deletedAt: string | null;
}

export interface FunnelStep {
  step: number;
  name: string | null;
  players: number;
  /** 0..1, against step 1. Not a percentage — the UI formats it. */
  completionRate: number;
  /** null on step 1: there is no previous step to churn from. */
  churnRate: number | null;
  /** null on step 1, and wherever no server ever reported a gap. */
  avgMs: number | null;
  samples: number;
}

export interface FunnelBucket {
  at: string;
  entrants: number;
  completed: number;
  /** The cohort has not finished yet, so completed/entrants reads artificially low. */
  partial: boolean;
}

export interface FunnelReport {
  funnelName: string;
  kind: FunnelKind;
  displayName: string | null;
  stepCount: number;
  entrants: number;
  completed: number;
  /** 0..1. */
  completionRate: number;
  steps: FunnelStep[];
  buckets: FunnelBucket[];
  lastEventAt: string | null;
  /** Optional: the report is about a range, not about row state, so the server may omit it.
   *  Undefined is read as "not deleted" and only decides which owner actions are offered. */
  deletedAt?: string | null;
}
