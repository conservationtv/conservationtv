import { errorResponse } from '@conservationtv/versioned-api/server';

// Gatekeeper's descriptions of the family's shared failure responses.
export { operationVersion, strictJsonBody, validator, versionMismatch } from '@conservationtv/versioned-api/server';

export const invalidRequest = errorResponse('The request or its grant is malformed');
export const unauthorized = errorResponse('The consumer token is missing or invalid');
export const forbidden = errorResponse('The requested endpoint cannot be admitted');
export const unavailable = errorResponse('A dependency required to decide the request is unavailable');
