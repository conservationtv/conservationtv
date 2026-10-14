import { errorResponse } from '@conservationtv/versioned-api/server';

// The studio API's descriptions of the family's shared failure responses.
export { operationVersion, strictJsonBody, validator, versionMismatch } from '@conservationtv/versioned-api/server';

export const invalidRequest = errorResponse('The request is malformed');
export const unauthenticated = errorResponse('No signed-in session was presented');
export const notFound = errorResponse('The resource does not exist or is not visible to this account');
export const unavailable = errorResponse('The database is unavailable');
