import { errorResponse } from '@conservationtv/versioned-api/server';

// Gatekeeper's descriptions of the family's shared failure responses.
export { operationVersion, strictJsonBody, validator, versionMismatch } from '@conservationtv/versioned-api/server';

export const invalidRequest = errorResponse('The request or its signed grant is malformed');
export const unauthorized = errorResponse('The grant assertion failed authentication or validation');
export const forbidden = errorResponse("The signed grant exceeds the consumer's delegation");
export const unavailable = errorResponse('A dependency required to decide the request is unavailable');
