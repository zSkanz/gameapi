import { describe, it, expect } from 'vitest';
import { LogBatchBody } from '../../src/modules/funnel/funnel.schemas';
import { MAX_FUNNEL_BATCH, MAX_FUNNEL_STEP, ONBOARDING_FUNNEL } from '../../src/core/constants';

/**
 * The funnel arithmetic, checked against the exact numbers on the reference dashboard. If any of
 * these drift, the panel is quietly reporting the wrong thing — which is worse than an error,
 * because a plausible number gets believed.
 *
 * These mirror the repository's shaping step (which lives in TypeScript, not SQL, on purpose: in
 * SQL it would be LAG + NULLIF for the divide-by-zero + CASE for step 1's "—").
 */
const players = [61_670, 58_632, 57_917, 57_197, 56_893, 55_739];

const completionRate = (p: number[], step: number): number => (p[0] === 0 ? 0 : p[step - 1]! / p[0]!);
const churnRate = (p: number[], step: number): number | null => {
  if (step === 1) return null;
  const prev = p[step - 2]!;
  return prev === 0 ? null : (prev - p[step - 1]!) / prev;
};

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;

describe('funnel arithmetic vs the reference dashboard', () => {
  it('reproduces every completion rate to the displayed decimal', () => {
    expect(pct(completionRate(players, 1))).toBe('100.0%');
    expect(pct(completionRate(players, 2))).toBe('95.1%');
    expect(pct(completionRate(players, 3))).toBe('93.9%');
    expect(pct(completionRate(players, 4))).toBe('92.7%');
    expect(pct(completionRate(players, 5))).toBe('92.3%');
    expect(pct(completionRate(players, 6))).toBe('90.4%'); // the headline OVERALL COMPLETION
  });

  it('reproduces every churn rate to the displayed decimal', () => {
    expect(churnRate(players, 1)).toBeNull(); // step 1 renders "—": no predecessor
    expect(pct(churnRate(players, 2)!)).toBe('4.9%');
    expect(pct(churnRate(players, 3)!)).toBe('1.2%');
    expect(pct(churnRate(players, 4)!)).toBe('1.2%');
    expect(pct(churnRate(players, 5)!)).toBe('0.5%');
    expect(pct(churnRate(players, 6)!)).toBe('2.0%');
  });

  it('churn measures the drop from the PREVIOUS step, not from the top', () => {
    // The distinction is invisible at step 2 (where both are 4.9%) and obvious by step 6.
    expect(pct(churnRate(players, 6)!)).toBe('2.0%');
    expect(pct(1 - completionRate(players, 6))).toBe('9.6%'); // cumulative, a different number
  });

  it('an empty funnel divides by zero nowhere', () => {
    const none = [0, 0, 0];
    expect(completionRate(none, 3)).toBe(0);
    expect(churnRate(none, 2)).toBeNull(); // renders "—", not NaN or Infinity
  });
});

/**
 * The reason funnel_run exists. players[] is derived from `max_step >= N`, so it is non-increasing
 * by construction and churn can never come out negative — even when a step log is lost.
 */
describe('monotonicity is structural', () => {
  /** Mirrors the repository: players[N] = count of runs whose max_step >= N. */
  const playersFrom = (maxSteps: number[], stepCount: number): number[] =>
    Array.from({ length: stepCount }, (_, i) => maxSteps.filter((m) => m >= i + 1).length);

  it('a dropped middle step cannot produce a negative churn rate', () => {
    // Three runs reached step 3. Under raw-event counting, a server that lost its step-2 log would
    // report players[3] > players[2] -> negative churn and completion over 100%.
    const derived = playersFrom([3, 3, 3, 1], 3);
    expect(derived).toEqual([4, 3, 3]);
    for (let step = 2; step <= 3; step++) expect(churnRate(derived, step)!).toBeGreaterThanOrEqual(0);
    for (let step = 1; step <= 3; step++) expect(completionRate(derived, step)).toBeLessThanOrEqual(1);
  });

  it('players[] is non-increasing for any input', () => {
    const derived = playersFrom([1, 5, 3, 2, 5, 1, 4], 5);
    for (let i = 1; i < derived.length; i++) expect(derived[i]!).toBeLessThanOrEqual(derived[i - 1]!);
  });

  it('counts a skipped step as passed — reaching step 3 means passing step 2', () => {
    expect(playersFrom([3], 3)).toEqual([1, 1, 1]);
  });
});

describe('the ingest schema mirrors Roblox\'s documented limits', () => {
  const ev = (over: Record<string, unknown> = {}) => ({ playerId: 1234567890, step: 1, ...over });
  const parse = (body: unknown) => LogBatchBody.safeParse(body);

  it('accepts steps 1-100 and rejects outside', () => {
    expect(MAX_FUNNEL_STEP).toBe(100); // Roblox: "Limited to steps 1-100"
    expect(parse({ events: [ev({ step: 1 })] }).success).toBe(true);
    expect(parse({ events: [ev({ step: 100 })] }).success).toBe(true);
    expect(parse({ events: [ev({ step: 0 })] }).success).toBe(false);
    expect(parse({ events: [ev({ step: 101 })] }).success).toBe(false);
  });

  it('caps the batch below the 16 KB body limit rather than letting Fastify 413 it', () => {
    expect(MAX_FUNNEL_BATCH).toBe(100);
    const full = Array.from({ length: MAX_FUNNEL_BATCH }, () => ev());
    expect(parse({ events: full }).success).toBe(true);
    expect(parse({ events: [...full, ev()] }).success).toBe(false);
    // The real payload has to actually fit, or the cap is a lie.
    const bytes = JSON.stringify({ funnelName: ONBOARDING_FUNNEL, events: full }).length;
    expect(bytes).toBeLessThan(16_384);
  });

  it('keeps only Roblox\'s three custom field keys and ignores the rest, as Roblox does', () => {
    const r = parse({ events: [ev({ customFields: { CustomField01: 'a', CustomField09: 'ignored' } })] });
    expect(r.success).toBe(true);
    // Passthrough keeps unknown keys on the parsed object; the repository reads only 01/02/03,
    // so an extra key is silently ignored exactly like Roblox ignores it.
    expect(r.success && r.data.events[0]!.customFields?.CustomField01).toBe('a');
  });

  it('defaults sessionId to absent, which the repository stores as the empty string', () => {
    const r = parse({ events: [ev()] });
    expect(r.success && r.data.events[0]!.sessionId).toBeUndefined();
    // '' is the stored value; NULL would make the UNIQUE index stop deduplicating.
    expect(parse({ events: [ev({ sessionId: 'x'.repeat(65) })] }).success).toBe(false);
  });

  it('defaults the funnel name to the reserved onboarding one', () => {
    const r = parse({ events: [ev()] });
    expect(r.success && r.data.funnelName).toBe(ONBOARDING_FUNNEL);
    expect(r.success && r.data.kind).toBe('custom');
  });
});
