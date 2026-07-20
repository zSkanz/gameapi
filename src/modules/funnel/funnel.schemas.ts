import { z } from 'zod';
import {
  FUNNEL_NAME_REGEX,
  GAME_ID_REGEX,
  MAX_FUNNEL_BATCH,
  MAX_FUNNEL_STEP,
  ONBOARDING_FUNNEL,
} from '../../core/constants';

export { ListQuery, parseBody } from '../../core/http/schemas';

/** Trim first: " Farm" and "Farm" must not become two funnels. */
export const funnelName = z
  .string()
  .trim()
  .regex(FUNNEL_NAME_REGEX, 'funnelName must be 1-64 characters and contain no control characters');

export const FunnelParams = z.object({
  gameId: z.string().regex(GAME_ID_REGEX),
  funnelName,
});

export const GameParams = z.object({ gameId: z.string().regex(GAME_ID_REGEX) });

/**
 * Roblox only reads CustomField01/02/03 and ignores every other key
 * (create.roblox.com/docs/production/analytics/custom-fields). We mirror that exactly — including
 * ignoring rather than rejecting, so a game that sends extra keys behaves the same against both.
 */
const CustomFields = z
  .object({
    CustomField01: z.string().max(200).optional(),
    CustomField02: z.string().max(200).optional(),
    CustomField03: z.string().max(200).optional(),
  })
  .partial()
  .passthrough()
  .optional();

const FunnelEvent = z
  .object({
    /**
     * Roblox UserId. Past 2^31 already, so bounded below 2^53 to keep a JS Number exact.
     *
     * NEGATIVE IS VALID and must stay valid: Studio's Test > Server + Players gives its fake
     * players UserIds of -1, -2, -3. Rejecting them means the funnel cannot be tested anywhere
     * except a published game, which is the opposite of useful during development.
     */
    playerId: z
      .number()
      .int()
      .min(-Number.MAX_SAFE_INTEGER)
      .max(Number.MAX_SAFE_INTEGER),
    step: z.number().int().min(1).max(MAX_FUNNEL_STEP, `step must be 1-${MAX_FUNNEL_STEP}, as on Roblox`),
    /** Roblox's funnelSessionId. Absent = a once-per-player funnel; '' is the real stored value. */
    sessionId: z.string().max(64).optional(),
    /** Unix seconds from the game's clock. Clamped in SQL, never trusted. */
    at: z.number().int().min(0).optional(),
    msSincePrev: z.number().int().min(0).optional(),
    customFields: CustomFields,
  })
  .strict();

export const LogBatchBody = z
  .object({
    funnelName: funnelName.default(ONBOARDING_FUNNEL),
    kind: z.enum(['onboarding', 'custom']).default('custom'),
    displayName: z.string().min(1).max(120).optional(),
    /**
     * Sent on every flush rather than registered separately: it is what makes get-or-create work
     * with no second endpoint, and it makes renaming a step self-healing.
     */
    steps: z.array(z.string().min(1).max(120)).max(MAX_FUNNEL_STEP).optional(),
    events: z.array(FunnelEvent).min(1).max(MAX_FUNNEL_BATCH),
  })
  .strict();

export type LogBatch = z.infer<typeof LogBatchBody>;
export type FunnelEventInput = z.infer<typeof FunnelEvent>;
