import { describe, it, expect } from 'vitest';
import {
  CONFIG_LIMITS,
  applyPatch,
  diffEntries,
  validateEntry,
  valuesOf,
  type ConfigEntries,
} from '../../src/modules/config/config.repository';
import { DraftBody } from '../../src/modules/config/config.routes';

/**
 * The rules every config write goes through. The transactional side (row lock, draftRevision
 * conflicts, publish/restore) was exercised against real Postgres when it was written; these pin
 * the parts that decide what a game ends up reading.
 */

const published: ConfigEntries = {
  bossHealth: { type: 'number', value: 300, description: 'Boss HP', updatedAt: '2026-09-01T00:00:00.000Z' },
  halloween: { type: 'boolean', value: false, description: '', updatedAt: '2026-09-01T00:00:00.000Z' },
};

describe('validateEntry', () => {
  it('accepts each type with a matching value', () => {
    expect(validateEntry('a', { type: 'string', value: 'hi' }).value).toBe('hi');
    expect(validateEntry('a', { type: 'number', value: -1.5 }).value).toBe(-1.5);
    expect(validateEntry('a', { type: 'boolean', value: true }).value).toBe(true);
    expect(validateEntry('a', { type: 'json', value: { sword: { price: 1 } } }).value).toEqual({ sword: { price: 1 } });
    expect(validateEntry('a', { type: 'json', value: [1, 2] }).value).toEqual([1, 2]);
  });

  it('rejects a value of the wrong type, naming the key', () => {
    expect(() => validateEntry('boss', { type: 'number', value: '300' })).toThrow(/Config "boss"/);
    expect(() => validateEntry('flag', { type: 'boolean', value: 1 })).toThrow(/true or false/);
    expect(() => validateEntry('s', { type: 'string', value: 5 })).toThrow(/text value/);
    expect(() => validateEntry('x', { type: 'date', value: 'x' })).toThrow(/type must be/);
  });

  it('JSON must be an object or array — null would read as "no such key" in a game', () => {
    expect(() => validateEntry('j', { type: 'json', value: null })).toThrow(/object or an array/);
    expect(() => validateEntry('j', { type: 'json', value: 'text' })).toThrow(/object or an array/);
  });

  it('enforces key shape and size limits', () => {
    for (const bad of ['', '1abc', 'has space', 'a'.repeat(101), 'emoji😀']) {
      expect(() => validateEntry(bad, { type: 'string', value: 'x' }), bad).toThrow(/not a valid config key/);
    }
    for (const good of ['a', 'shop.sword-price', 'Boss_HP2', 'a'.repeat(100)]) {
      expect(() => validateEntry(good, { type: 'string', value: 'x' }), good).not.toThrow();
    }
    expect(() => validateEntry('s', { type: 'string', value: 'x'.repeat(CONFIG_LIMITS.maxStringLength + 1) })).toThrow(/limited/);
    expect(() => validateEntry('s', { type: 'string', value: 'x', description: 'd'.repeat(501) })).toThrow(/description/);
  });

  it('a non-finite number never becomes a config (JSON would turn it into null)', () => {
    expect(() => validateEntry('n', { type: 'number', value: Number.NaN })).toThrow(/finite/);
    expect(() => validateEntry('n', { type: 'number', value: Number.POSITIVE_INFINITY })).toThrow(/finite/);
  });
});

describe('applyPatch', () => {
  it('sets listed keys, removes null ones, leaves the rest', () => {
    const next = applyPatch(published, { bossHealth: { type: 'number', value: 500 }, halloween: null, shop: { type: 'json', value: {} } });
    expect(Object.keys(next).sort()).toEqual(['bossHealth', 'shop']);
    expect(next.bossHealth!.value).toBe(500);
  });

  it('keeps updatedAt when only the description changes, drops it when the value does', () => {
    const same = applyPatch(published, { bossHealth: { type: 'number', value: 300, description: 'renamed' } });
    expect(same.bossHealth!.updatedAt).toBe('2026-09-01T00:00:00.000Z');
    const changed = applyPatch(published, { bossHealth: { type: 'number', value: 301 } });
    expect(changed.bossHealth!.updatedAt).toBeUndefined();
  });

  it('refuses a config past the key count', () => {
    const many = Object.fromEntries(Array.from({ length: CONFIG_LIMITS.maxKeys + 1 }, (_, i) => [`k${i}`, { type: 'boolean' as const, value: true }]));
    expect(() => applyPatch({}, many)).toThrow(/at most 1,000 configs/);
  });
});

describe('diffEntries', () => {
  it('reports added, removed, changed and description-only keys, sorted', () => {
    const after: ConfigEntries = {
      bossHealth: { type: 'number', value: 300, description: 'Boss health' },
      shop: { type: 'json', value: { sword: 1 }, description: '' },
    };
    expect(diffEntries(published, after)).toEqual({
      bossHealth: { before: { type: 'number', value: 300 }, after: { type: 'number', value: 300 }, descriptionOnly: true },
      halloween: { before: { type: 'boolean', value: false }, after: null },
      shop: { before: null, after: { type: 'json', value: { sword: 1 } } },
    });
  });

  it('a type change with an equal-looking value is a change', () => {
    const after: ConfigEntries = { ...published, bossHealth: { type: 'string', value: '300', description: 'Boss HP' } };
    expect(Object.keys(diffEntries(published, after))).toEqual(['bossHealth']);
  });

  it('identical states have no diff', () => {
    expect(diffEntries(published, structuredClone(published))).toEqual({});
  });
});

describe('what a game reads', () => {
  it('is just key -> value', () => {
    expect(valuesOf(published)).toEqual({ bossHealth: 300, halloween: false });
  });
});

describe('draft body', () => {
  it('accepts entries and null deletions; rejects unknown fields', () => {
    expect(DraftBody.safeParse({ entries: { a: { type: 'number', value: 1 }, b: null }, draftRevision: 3 }).success).toBe(true);
    expect(DraftBody.safeParse({ entries: { a: { type: 'nope', value: 1 } } }).success).toBe(false);
    expect(DraftBody.safeParse({ entries: {}, extra: true }).success).toBe(false);
  });
});
