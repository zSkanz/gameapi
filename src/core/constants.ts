/**
 * Single source of truth for numeric bounds shared by Zod schemas AND the Lua guards.
 * MAX_STOCK is the absolute hard ceiling for every stock value and input; per-record
 * `max` lives in [0, MAX_STOCK]. All bounds stay < 2^53 so JS/Lua integer math is exact.
 */
export const MAX_STOCK = 1_000_000_000; // 1e9, < 2^53

export const MIN_STOCK = 0;
export const MAX_AMOUNT = MAX_STOCK; // decrease amount upper bound
export const MAX_DELTA = MAX_STOCK; // |adjust delta| upper bound

/** Serial numbers are bigint in Postgres; bound inputs below 2^53 so JS reads stay exact. */
export const MAX_SERIAL = Number.MAX_SAFE_INTEGER; // 9_007_199_254_740_991

/** Identifier charsets (also enforced at the Redis key layer). */
export const GAME_ID_REGEX = /^[A-Za-z0-9:_.\-]{1,64}$/;
export const STOCK_KEY_REGEX = /^[A-Za-z0-9:_.\-]{1,128}$/;
export const IDEMPOTENCY_KEY_REGEX = /^[A-Za-z0-9_\-]{8,128}$/;

/** Panel account names. No ':' — usernames appear in ledger actor ids as `panel:<userId>`. */
export const PANEL_USERNAME_REGEX = /^[A-Za-z0-9_.\-]{3,64}$/;

/**
 * Funnel bounds. The first four mirror Roblox's AnalyticsService exactly, so a game that already
 * satisfies their API satisfies ours — see create.roblox.com/docs/production/analytics/funnel-events.
 */
export const MAX_FUNNEL_STEP = 100; // Roblox: "Limited to steps 1-100"
export const MAX_CUSTOM_FUNNELS = 10; // Roblox: "Limited to 10 unique funnels per experience"

/**
 * Funnel names are whatever a person would type in Studio — "Onboarding Farm" is a perfectly
 * ordinary Roblox funnel name, and this used to reject it.
 *
 * The first version reused the stock-key charset, which bans spaces. That was stricter than
 * Roblox for no reason, and since the whole point of this module is to mirror their API, being
 * stricter than them is a bug: the game logged happily to Roblox and got VALIDATION_ERROR here.
 *
 * Only control characters are excluded — they would break the Discord log line and the panel
 * table without ever being something anyone meant to type. Leading/trailing space is trimmed by
 * the schema before this runs, so " Farm" and "Farm" cannot become two funnels.
 */
export const FUNNEL_NAME_REGEX = /^[^\x00-\x1F]{1,64}$/;
/** The one funnel Roblox gives no name to (LogOnboardingFunnelStepEvent takes no funnelName). */
export const ONBOARDING_FUNNEL = 'onboarding';

/**
 * Events per ingest request. Roughly 200 fit in BODY_LIMIT_BYTES (16 KB); half that is deliberate
 * headroom, because a 413 on an analytics flush means the client either drops the batch or retries
 * it forever — silent data loss on a size boundary that only shows up in production.
 */
export const MAX_FUNNEL_BATCH = 100;

/**
 * How far back a client-supplied event timestamp may reach. Derived, not picked: the Lua retry
 * loop is 0.5s * 5 attempts = 7.5s, plus a 20s flush interval, plus the BindToClose drain.
 * Generous against all of that, and small enough that a garbage clock cannot rewrite last week.
 */
export const FUNNEL_MAX_BACKDATE_MS = 900_000; // 15 minutes
