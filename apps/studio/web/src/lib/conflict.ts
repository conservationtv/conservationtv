import { HttpError } from '@conservationtv/studio-sdk';

/**
 * A mutation's failure, with a refusal because the name is already taken (409) said in the page's own words: the API
 * says only that there is a conflict, and the page knows what with. Any other failure is left as it is.
 */
export function conflictAs(error: Error | null, message: string): Error | null {
  if (error instanceof HttpError && error.status === 409) return new Error(message, { cause: error });
  return error;
}
