import { z } from 'zod';
import { GAME_ID_REGEX, STOCK_KEY_REGEX, MAX_SERIAL } from '../../core/constants';

export { ListQuery, parseBody } from '../../core/http/schemas';

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

