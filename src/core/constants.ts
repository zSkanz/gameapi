/**
 * Single source of truth for numeric bounds shared by Zod schemas AND the Lua guards.
 * MAX_STOCK is the absolute hard ceiling for every stock value and input; per-record
 * `max` lives in [0, MAX_STOCK]. All bounds stay < 2^53 so JS/Lua integer math is exact.
 */
export const MAX_STOCK = 1_000_000_000; // 1e9, < 2^53

export const MIN_STOCK = 0;
export const MAX_AMOUNT = MAX_STOCK; // decrease amount upper bound
export const MAX_DELTA = MAX_STOCK; // |adjust delta| upper bound

/** Identifier charsets (also enforced at the Redis key layer). */
export const GAME_ID_REGEX = /^[A-Za-z0-9:_.\-]{1,64}$/;
export const STOCK_KEY_REGEX = /^[A-Za-z0-9:_.\-]{1,128}$/;
export const IDEMPOTENCY_KEY_REGEX = /^[A-Za-z0-9_\-]{8,128}$/;
