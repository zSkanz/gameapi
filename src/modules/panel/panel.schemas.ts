import { z } from 'zod';
import { GAME_ID_REGEX, PANEL_USERNAME_REGEX, STOCK_KEY_REGEX, MAX_STOCK, MAX_DELTA, MAX_SERIAL } from '../../core/constants';

export { parseBody, ListQuery } from '../../core/http/schemas';

/** Long enough to matter, bounded so a 1 MB "password" cannot buy 1 MB of scrypt. */
const password = z.string().min(12).max(200);

export const LoginBody = z
  .object({ username: z.string().min(1).max(64), password: z.string().min(1).max(200) })
  .strict();

export const ChangePasswordBody = z
  .object({ currentPassword: z.string().min(1).max(200), newPassword: password })
  .strict()
  .refine((b) => b.currentPassword !== b.newPassword, { message: 'The new password must be different.' });

export const CreateUserBody = z
  .object({ username: z.string().regex(PANEL_USERNAME_REGEX), role: z.enum(['owner', 'admin']).default('admin') })
  .strict();

export const UpdateUserBody = z
  .object({ role: z.enum(['owner', 'admin']).optional(), disabled: z.boolean().optional() })
  .strict()
  .refine((b) => b.role !== undefined || b.disabled !== undefined, { message: 'Nothing to update.' });

export const UserParams = z.object({ userId: z.string().regex(/^pu_[0-9a-f]{16}$/) });

// ---- games ----
export const GameParams = z.object({ gameId: z.string().regex(GAME_ID_REGEX) });

export const CreateGameBody = z
  .object({
    gameId: z.string().regex(GAME_ID_REGEX),
    name: z.string().min(1).max(120),
    maxKeys: z.number().int().min(1).max(1_000_000).default(10_000),
  })
  .strict();

export const GameListQuery = z.object({
  q: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

// ---- api keys ----
export const KeyParams = GameParams.extend({ keyId: z.string().regex(/^gk_[A-Za-z0-9_-]{12}$/) });

export const CreateKeyBody = z
  .object({
    label: z.string().min(1).max(80),
    // Clamped to the game scopes by the schema itself: a panel scope on an api key would be a
    // privilege escalation, and DbApiKeyStore strips them again on read.
    scopes: z
      .array(z.enum(['stock:read', 'stock:write', 'serial:read', 'serial:write']))
      .min(1)
      .default(['stock:read', 'stock:write', 'serial:read', 'serial:write']),
  })
  .strict();

export const KeyListQuery = z.object({
  includeRevoked: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

// ---- stock ----
export const StockParams = GameParams.extend({ stockKey: z.string().regex(STOCK_KEY_REGEX) });

export const PanelStockListQuery = z.object({
  q: z.string().max(128).optional(),
  includeDeleted: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export const CreateStockBody = z
  .object({
    stockKey: z.string().regex(STOCK_KEY_REGEX),
    stock: z.number().int().min(0).max(MAX_STOCK),
    max: z.number().int().min(0).max(MAX_STOCK),
  })
  .strict()
  .refine((b) => b.stock <= b.max, { message: 'stock cannot exceed max' });

export const SetStockBody = z.object({ stock: z.number().int().min(0).max(MAX_STOCK) }).strict();
export const SetMaxBody = z.object({ max: z.number().int().min(0).max(MAX_STOCK) }).strict();
export const AdjustBody = z
  .object({ delta: z.number().int().min(-MAX_DELTA).max(MAX_DELTA).refine((v) => v !== 0, 'delta must be non-zero') })
  .strict();
export const DecreaseBody = z.object({ amount: z.number().int().min(1).max(MAX_STOCK) }).strict();

// ---- serial ----
export const SerialParams = GameParams.extend({ serialKey: z.string().regex(STOCK_KEY_REGEX) });

export const CreateSerialBody = z
  .object({
    serialKey: z.string().regex(STOCK_KEY_REGEX),
    start: z.number().int().min(0).max(MAX_SERIAL).default(1),
    max: z.number().int().min(1).max(MAX_SERIAL).nullable().optional(),
    stockKey: z.string().regex(STOCK_KEY_REGEX).nullable().optional(),
  })
  .strict()
  .refine((b) => b.max == null || b.max >= b.start, { message: 'max must be >= start' });

export const UpdateSerialBody = z
  .object({
    max: z.number().int().min(1).max(MAX_SERIAL).nullable().optional(),
    stockKey: z.string().regex(STOCK_KEY_REGEX).nullable().optional(),
  })
  .strict()
  .refine((b) => b.max !== undefined || b.stockKey !== undefined, { message: 'Nothing to update.' });

/**
 * Purge is irreversible and destroys the ledger, so it asks the operator to type the key back.
 * The confirm value is checked against the path param in the handler.
 */
export const ConfirmBody = z.object({ confirm: z.string().min(1).max(128) }).strict();
