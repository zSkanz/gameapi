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
  // Hop count, not a flag. `true` trusts EVERY hop, which makes Fastify read the leftmost
  // X-Forwarded-For entry — the one a client can forge — and that is the value the panel's
  // login throttle buckets on. 1 = trust only Caddy. The legacy true/false spellings are
  // still accepted (true -> 1, false -> 0) so an existing .env keeps booting: this var is
  // already TRUST_PROXY=true in every deployed .env, and .env is git-ignored, so a rejected
  // value would fail loadConfig() and crashloop every replica on the next deploy.
  TRUST_PROXY: z
    .union([z.coerce.number().int().min(0), boolish.transform((b) => (b ? 1 : 0))])
    .default(1),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
  BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(16_384),
  METRICS_ENABLED: boolish.default('true'),

  REDIS_URL: z.string().url().default('redis://localhost:6379/0'),
  REDIS_KEY_PREFIX: z.string().default('gapi:v1:'),

  DATABASE_URL: z.string().default('postgres://gameapi:gameapi@localhost:5432/gameapi'),
  PG_POOL_MAX: z.coerce.number().int().positive().default(10),

  // The .env wildcard key. Flip to false once every game uses a per-game key; API_KEYS is
  // then not required at all. `boolish`, never z.coerce.boolean() — the latter is Boolean(v),
  // so the string 'false' would be TRUE and this kill-switch could never be switched off.
  BOOTSTRAP_API_KEY_ENABLED: boolish.default('true'),

  MAX_STOCK: z.coerce.number().int().positive().default(1_000_000_000),
  AUTO_PROVISION_GAMES: boolish.default('true'),
  READ_CACHE_TTL_SECONDS: z.coerce.number().int().min(0).default(3), // 0 disables the read cache
  CLUSTER_WORKERS: z.coerce.number().int().min(1).default(1), // >1 forks N workers per process

  RATE_LIMIT_KEY_PER_MIN: z.coerce.number().int().positive().default(6_000),
  RATE_LIMIT_GAME_PER_MIN: z.coerce.number().int().positive().default(12_000),

  // ---- panel ----
  // Normalized to scheme://host[:port] at boot. z.string().url() happily accepts
  // 'https://p.example.com/' — a trailing slash is the likeliest way to paste this — and a
  // raw comparison against the browser's Origin header would then 403 every mutation.
  PANEL_ORIGIN: z
    .string()
    .url()
    .transform((v) => new URL(v).origin)
    .optional(),
  PANEL_SESSION_IDLE_MINUTES: z.coerce.number().int().positive().default(480), // 8h
  PANEL_SESSION_ABSOLUTE_HOURS: z.coerce.number().int().positive().default(168), // 7d
  PANEL_LOGIN_MAX_PER_IP: z.coerce.number().int().positive().default(20),
  PANEL_LOGIN_MAX_PER_USER: z.coerce.number().int().positive().default(5),
  PANEL_LOGIN_WINDOW_SECONDS: z.coerce.number().int().positive().default(900), // 15m
}).superRefine((env, ctx) => {
  // The panel is a requirement, not a feature flag, so this is unconditional in production:
  // without an origin to compare against there is no Origin check, and SameSite=Strict alone
  // leaves the same-site-but-cross-origin gap open.
  if (env.NODE_ENV === 'production') {
    if (!env.PANEL_ORIGIN) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['PANEL_ORIGIN'], message: 'is required in production' });
    } else if (!env.PANEL_ORIGIN.startsWith('https://')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PANEL_ORIGIN'],
        message: 'must be https in production — the session cookie is Secure and __Host- prefixed',
      });
    }
  }
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

  // Only a requirement while the bootstrap key is the auth path. With the flag off, per-game
  // keys come from the api_keys table and API_KEYS is legitimately absent.
  if (parsed.data.BOOTSTRAP_API_KEY_ENABLED && apiKeys.length === 0) {
    throw new Error(
      'No API keys configured. Set API_KEYS or API_KEYS_FILE, or set BOOTSTRAP_API_KEY_ENABLED=false ' +
        'once every game has migrated to a per-game key.',
    );
  }

  cached = {
    env: parsed.data,
    apiKeys,
    redisPassword: readSecret('REDIS_PASSWORD'),
    pgPassword: readSecret('PGPASSWORD'),
  };
  return cached;
}
