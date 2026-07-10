import 'fastify';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import type { AppConfig } from '../config/env';
import type { ApiKeyStore, Principal } from '../core/auth/principal';

declare module 'fastify' {
  interface FastifyInstance {
    config: AppConfig;
    redis: Redis;
    pg: Pool;
    apiKeys: ApiKeyStore;
  }

  interface FastifyRequest {
    principal?: Principal;
    idempotencyKey?: string;
  }

  // per-route config flags
  interface FastifyContextConfig {
    public?: boolean;
  }
}
