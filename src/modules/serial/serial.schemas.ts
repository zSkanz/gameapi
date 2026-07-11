import { z } from 'zod';
import { GAME_ID_REGEX, STOCK_KEY_REGEX, MAX_SERIAL } from '../../core/constants';
import { AppError, type ErrorCode } from '../../core/errors/app-error';

export const SerialParams = z.object({
  gameId: z.string().regex(GAME_ID_REGEX),
  serialKey: z.string().regex(STOCK_KEY_REGEX), // same key charset as stock
});

export const SerialGameParams = z.object({ gameId: z.string().regex(GAME_ID_REGEX) });

export const GetSerialBody = z
  .object({
    start: z.number().int().min(0).max(MAX_SERIAL).default(1),
    max: z.number().int().min(1).max(MAX_SERIAL).nullable().optional(), // null/absent = infinite
    stockKey: z.string().regex(STOCK_KEY_REGEX).nullable().optional(), // link to a stock key
  })
  .strict()
  .refine((b) => b.max == null || b.max >= b.start, { message: 'max must be >= start' });

export const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

/** Parse a body with a schema, mapping any failure to a module-specific error code. */
export function parseBody<S extends z.ZodTypeAny>(schema: S, body: unknown, code: ErrorCode): z.infer<S> {
  const result = schema.safeParse(body ?? {});
  if (!result.success) {
    throw new AppError(code, result.error.issues[0]?.message ?? 'Invalid request body.', {
      details: { issues: result.error.issues },
    });
  }
  return result.data;
}
