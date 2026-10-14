import { apiError, createErrorHandler } from '@conservationtv/versioned-api/server';
import { ApiFailure } from '../errors.ts';

export { handleNotFound } from '@conservationtv/versioned-api/server';

/** The API's own failures first; the common handler renders routing, version and validation failures. */
export const handleError = createErrorHandler((error, c) => {
  if (!(error instanceof ApiFailure)) return undefined;
  if (error.cause !== undefined) console.warn(JSON.stringify({ event: error.code, cause: String(error.cause) }));
  return apiError(c, error.code, error.message, error.status);
});
