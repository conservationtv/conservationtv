import { apiError, createErrorHandler } from '@conservationtv/versioned-api/server';
import { DrizzleQueryError } from 'drizzle-orm';
import pg from 'pg';
import { ApiFailure } from '../errors.ts';

export { handleNotFound } from '@conservationtv/versioned-api/server';

/**
 * The failure a statement the database refused means, by its SQLSTATE; undefined for anything else. Handlers run
 * ordinary queries in the request session and let row-level security and constraints decide, so the refusals they
 * don't handle themselves are reported here.
 */
function refusal(cause: unknown) {
  if (!(cause instanceof DrizzleQueryError) || !(cause.cause instanceof pg.DatabaseError)) return undefined;
  const { code, detail } = cause.cause;
  // Row-level security refused an insert, or an immutable column was changed.
  if (code === '42501') return new ApiFailure('forbidden', { cause });
  // A foreign key: a row still referenced (when deleting), or a missing or other organisation's reference.
  if (code === '23503')
    return new ApiFailure(detail?.includes('is still referenced') ? 'in_use' : 'invalid_reference', { cause });
  if (code === '23505' || code === '23514') return new ApiFailure('conflict', { cause });
  return undefined;
}

/** The API's own failures and database refusals first; the common handler renders routing, version and validation failures. */
export const handleError = createErrorHandler((error, c) => {
  const failure = error instanceof ApiFailure ? error : refusal(error);
  if (failure === undefined) return undefined;
  if (failure.cause !== undefined) console.warn(JSON.stringify({ event: failure.code, cause: String(failure.cause) }));
  return apiError(c, failure.code, failure.message, failure.status);
});
