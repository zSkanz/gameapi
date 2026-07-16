import { z } from 'zod';
import { AppError, type ErrorCode } from '../errors/app-error';

/** Pagination shared by every list endpoint. */
export const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * Parse a body with a schema, mapping any failure to a module-specific error code.
 *
 * Generic over the schema (not its output) so `.refine()`/`.transform()` schemas — which are
 * ZodEffects, not ZodType<T> — keep their inferred type instead of widening to the input type.
 */
export function parseBody<S extends z.ZodTypeAny>(
  schema: S,
  body: unknown,
  code: ErrorCode = 'VALIDATION_ERROR',
): z.infer<S> {
  const result = schema.safeParse(body ?? {});
  if (!result.success) {
    throw new AppError(code, result.error.issues[0]?.message ?? 'Invalid request body.', {
      details: { issues: result.error.issues },
    });
  }
  return result.data;
}
