import { apiError, createErrorHandler } from '@conservationtv/versioned-api/server';
import { GrantError } from '../errors.ts';

export { handleNotFound } from '@conservationtv/versioned-api/server';

/** Rejections are logged with their private cause; the common handler renders routing, version and validation failures. */
export const handleError = createErrorHandler((error, c) => {
  if (!(error instanceof GrantError)) return undefined;
  console.warn(JSON.stringify({ event: 'grant_rejected', code: error.code, cause: String(error.cause ?? '') }));
  return apiError(c, error.code, error.message, error.status);
});
