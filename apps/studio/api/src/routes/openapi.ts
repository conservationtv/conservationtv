import { errorResponse } from '@conservationtv/versioned-api/server';

// The studio API's descriptions of the family's shared failure responses.
export { operationVersion, validator, versionMismatch } from '@conservationtv/versioned-api/server';

export const invalidRequest = errorResponse('The request is malformed');
export const unauthenticated = errorResponse('No signed-in session was presented');
export const forbidden = errorResponse('The resource is visible, but this account may not do this to it');
export const notFound = errorResponse('The resource does not exist or is not visible to this account');
export const accountNotFound = errorResponse(
  'The organisation does not exist or is not visible to this account, or the invited account does not exist'
);
export const alreadyMember = errorResponse('The account is already a member of the organisation');
export const alreadyInvited = errorResponse(
  'The recipient is already a member, or already has an open invitation to the organisation'
);
export const invalidCode = errorResponse('The invitation is for an email address, and its code is missing or wrong');
export const expired = errorResponse('The invitation has expired');
export const lastAdmin = errorResponse('The organisation would be left without an administrator');
export const unavailable = errorResponse('The database is unavailable');
export const inUse = errorResponse('The resource is still used by another resource');
export const conflict = errorResponse('The change conflicts with the current state of the resource');
export const invalidReference = errorResponse(
  'A referenced resource does not exist, is not visible to this account, or belongs to another organisation'
);
export const revisionHasErrors = errorResponse('The revision has errors, so it cannot be served');
export const invalidSignature = errorResponse('The signing key is unknown or revoked, or the signature is wrong');
export const metricSeriesConflict = errorResponse('The metric series is already reported with another type or unit');
