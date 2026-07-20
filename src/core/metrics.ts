import client from 'prom-client';

/** Dedicated registry so we control exactly what /metrics exposes. */
export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

export const httpDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [registry],
});

export const stockOperations = new client.Counter({
  name: 'stock_operations_total',
  help: 'Stock operations by op and result',
  labelNames: ['op', 'result'] as const, // result = ok|clamped|replayed|not_found|created|capped|fallback
  registers: [registry],
});

export const funnelEvents = new client.Counter({
  name: 'funnel_events_total',
  help: 'Funnel events by outcome',
  // A systematically skewed game clock shows up here as clamped_* climbing, which is the cheap
  // version of storing a received_at column on a multi-million-row table.
  labelNames: ['result'] as const, // accepted|duplicate|dropped|clamped_future|clamped_past
  registers: [registry],
});
