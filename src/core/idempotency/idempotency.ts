import { createHash } from 'node:crypto';

/**
 * Stable JSON: object keys sorted recursively so the fingerprint is invariant to key
 * order. Bodies here are tiny ({amount} / {delta} / {targetStockMax} / {expectedStock}).
 */
function canonicalJSON(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJSON(obj[k])}`).join(',')}}`;
}

/**
 * Fingerprint binds an Idempotency-Key to the RESOLVED resource address + payload, so
 * the same key reused for a different op/body is detected (422) instead of replaying a
 * wrong cached answer. Includes gameId+stockKey+action (never the route template).
 */
export function fingerprint(
  gameId: string,
  resourceKey: string,
  action: string,
  body: unknown,
): string {
  return createHash('sha256')
    .update(`${gameId}\n${resourceKey}\n${action}\n${canonicalJSON(body)}`)
    .digest('hex');
}
