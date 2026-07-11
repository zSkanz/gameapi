import { readFileSync } from 'node:fs';
import { z } from 'zod';
import * as dotenv from 'dotenv';

dotenv.config();

/**
 * Resolve a secret: if `${name}_FILE` is set, read the file (docker secret); otherwise
 * fall back to the plain `${name}` env var. File wins so production never puts the
 * secret in the environment table.
 */
function readSecret(name: string): string | undefined {
  const fileVar = process.env[`${name}_FILE`];
  if (fileVar) {
    try {
      return readFileSync(fileVar, 'utf8').trim();
    } catch (err) {
      throw new Error(`Failed to read ${name}_FILE at ${fileVar}: ${(err as Error).message}`);
    }
  }
  return process.env[name];
}

const boolish = z
  .string()
  .transform((v) => v === 'true' || v === '1' || v === 'yes')
  .pipe(z.boolean());

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  TRUST_PROXY: boolish.default('true'),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
  BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(16_384),
  METRICS_ENABLED: boolish.default('true'),

  REDIS_URL: z.string().url().default('redis://localhost:6379/0'),
  REDIS_KEY_PREFIX: z.string().default('gapi:v1:'),

  DATABASE_URL: z.string().default('postgres://gameapi:gameapi@localhost:5432/gameapi'),
  PG_POOL_MAX: z.coerce.number().int().positive().default(10),

  MAX_STOCK: z.coerce.number().int().positive().default(1_000_000_000),
  AUTO_PROVISION_GAMES: boolish.default('true'),
  READ_CACHE_TTL_SECONDS: z.coerce.number().int().min(0).default(3), // 0 disables the read cache
  CLUSTER_WORKERS: z.coerce.number().int().min(1).default(1), // >1 forks N workers per process

  RATE_LIMIT_KEY_PER_MIN: z.coerce.number().int().positive().default(6_000),
  RATE_LIMIT_GAME_PER_MIN: z.coerce.number().int().positive().default(12_000),
});

export interface AppConfig {
  env: z.infer<typeof EnvSchema>;
  apiKeys: string[]; // resolved from API_KEYS_FILE or API_KEYS
  redisPassword: string | undefined;
  pgPassword: string | undefined;
}

let cached: AppConfig | undefined;

/** Parse + validate configuration once, fail-fast at boot on any problem. */
export function loadConfig(): AppConfig {
  if (cached) return cached;

  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }

  const apiKeysRaw = readSecret('API_KEYS');
  const apiKeys = (apiKeysRaw ?? '')
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k.length > 0);

  if (apiKeys.length === 0) {
    throw new Error('No API keys configured. Set API_KEYS or API_KEYS_FILE.');
  }

  cached = {
    env: parsed.data,
    apiKeys,
    redisPassword: readSecret('REDIS_PASSWORD'),
    pgPassword: readSecret('PGPASSWORD'),
  };
  return cached;
}
