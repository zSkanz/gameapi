import { z } from 'zod';
import { MAX_STOCK, MAX_AMOUNT, MAX_DELTA, GAME_ID_REGEX, STOCK_KEY_REGEX } from '../../core/constants';
import { AppError, type ErrorCode } from '../../core/errors/app-error';

export const StockParams = z.object({
  gameId: z.string().regex(GAME_ID_REGEX),
  stockKey: z.string().regex(STOCK_KEY_REGEX),
});

export const GameParams = z.object({ gameId: z.string().regex(GAME_ID_REGEX) });

export const DecreaseBody = z
  .object({ amount: z.number().int().min(1).max(MAX_AMOUNT) })
  .strict();

export const AdjustBody = z
  .object({
    delta: z
      .number()
      .int()
      .min(-MAX_DELTA)
      .max(MAX_DELTA)
      .refine((v) => v !== 0, 'delta must be non-zero'),
  })
  .strict();

export const GetBody = z
  .object({ expectedStock: z.number().int().min(0).max(MAX_STOCK).optional() })
  .strict();

export const SetMaxBody = z
  .object({ targetStockMax: z.number().int().min(0).max(MAX_STOCK) })
  .strict();

export const BatchGetBody = z
  .object({ stockKeys: z.array(z.string().regex(STOCK_KEY_REGEX)).min(1).max(100) })
  .strict();

/** Parse a body with a schema, mapping any failure to a module-specific error code. */
export function parseBody<T>(schema: z.ZodType<T>, body: unknown, code: ErrorCode): T {
  const result = schema.safeParse(body ?? {});
  if (!result.success) {
    throw new AppError(code, result.error.issues[0]?.message ?? 'Invalid request body.', {
      details: { issues: result.error.issues },
    });
  }
  return result.data;
}
