import { describe, it, expect } from 'vitest';
import { churnLevel } from '../../src/panel-ui/pages/FunnelDetail';

/**
 * The bands that decide whether a drop-off is shouted about. Absolute, not relative to the
 * funnel: 4% means the same thing whether the rest of the funnel is flat or terrible, and a
 * relative scale would paint a healthy funnel red just because something has to be worst.
 */
describe('churn emphasis', () => {
  it('stays quiet below 5%', () => {
    for (const r of [0, 0.001, 0.02, 0.0499]) expect(churnLevel(r), String(r)).toBe('');
  });

  it('warns from 5%, escalates from 15%', () => {
    expect(churnLevel(0.05)).toBe('warn');
    expect(churnLevel(0.149)).toBe('warn');
    expect(churnLevel(0.15)).toBe('danger');
    expect(churnLevel(0.9)).toBe('danger');
  });

  // Step 1 has no predecessor, so its churn is null — absent, not zero. Painting it green would
  // be a claim about a number that does not exist.
  it('says nothing at all when there is no previous step', () => {
    expect(churnLevel(null)).toBe('');
  });
});
