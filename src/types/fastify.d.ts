import 'fastify';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import type { AppConfig } from '../config/env';
import type { ApiKeyStore, PanelSession, Principal } from '../core/auth/principal';
import type { PanelSessions } from '../core/auth/session';
import type { RouteDoc } from '../core/docs/types';

declare module 'fastify' {
  interface FastifyInstance {
    config: AppConfig;
    redis: Redis;
    pg: Pool;
    apiKeys: ApiKeyStore;
    panelSessions: PanelSessions;
    /** Sliding-window meter: throws RATE_LIMITED past `limit` per minute; fails open without Redis. */
    rateLimit: (id: string, limit: number, cost?: number) => Promise<void>;
  }

  interface FastifyRequest {
    principal?: Principal;
    /** Set only by the cookie path. Its absence is what keeps api keys out of the panel. */
    panel?: PanelSession;
    idempotencyKey?: string;
  }

  // per-route config flags
  interface FastifyContextConfig {
    /** Skips authentication entirely. */
    public?: boolean;
    /**
     * Authenticate with the panel session cookie instead of x-api-key. 'anon' allows an
     * absent/invalid session through (login, logout) — the route must then not assume req.panel.
     */
    session?: boolean | 'anon';
    /** Reachable while must_change_password is set — only the routes that can clear it. */
    pwExempt?: boolean;
    docs?: RouteDoc;
    /**
     * Charge this route to its own request bucket instead of the key/game ones — for high-frequency
     * polling that must not starve a game's real calls. The bucket still caps abuse.
     */
    rateLimitBucket?: 'config-poll';
  }
}
