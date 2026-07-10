import { describe, it, expect } from 'vitest';
import { fingerprint } from '../../src/core/idempotency/idempotency';

describe('fingerprint', () => {
  it('is stable regardless of body key order', () => {
    const a = fingerprint('g', 's', 'decrease', { amount: 10, note: 'x' });
    const b = fingerprint('g', 's', 'decrease', { note: 'x', amount: 10 });
    expect(a).toBe(b);
  });

  it('differs by resource address (no cross-key collision)', () => {
    const a = fingerprint('g', 'excalibur', 'decrease', { amount: 10 });
    const b = fingerprint('g', 'shield', 'decrease', { amount: 10 });
    expect(a).not.toBe(b);
  });

  it('differs by action and payload', () => {
    expect(fingerprint('g', 's', 'decrease', { amount: 10 })).not.toBe(
      fingerprint('g', 's', 'adjust', { amount: 10 }),
    );
    expect(fingerprint('g', 's', 'decrease', { amount: 10 })).not.toBe(
      fingerprint('g', 's', 'decrease', { amount: 11 }),
    );
  });
});
