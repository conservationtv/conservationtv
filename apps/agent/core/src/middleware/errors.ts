import { NotMutating } from '@conservationtv/converge';
import { apiError, createErrorHandler } from '@conservationtv/versioned-api/server';
import { z } from 'zod';
import { SpecConflict } from '../errors.ts';

export { handleNotFound } from '@conservationtv/versioned-api/server';

/**
 * Changes to the spec the agent turns away first; the common handler renders routing, version and validation
 * failures. Only a change to the spec parses it outside a validator, so a `ZodError` is a change that would leave it
 * invalid.
 */
export const handleError = createErrorHandler((error, c) => {
  if (error instanceof NotMutating)
    return apiError(c, 'not_configurable', 'This agent is configured by the studio, not over this API.', 409);
  if (error instanceof SpecConflict) return apiError(c, 'conflict', error.message, 409);
  if (error instanceof z.ZodError) return apiError(c, 'invalid_spec', z.prettifyError(error), 422);
  return undefined;
});
