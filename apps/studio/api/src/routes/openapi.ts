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
export const leaseUnavailable = errorResponse('The database is unavailable, or the relay cannot lease the endpoint');
export const tokenUnavailable = errorResponse('The database is unavailable, or the relay cannot issue a token');
export const endpointRefused = errorResponse(
  "The relay will never admit the device's endpoint: it is denied, or leased to another service"
);
export const inUse = errorResponse('The resource is still used by another resource');
export const conflict = errorResponse('The change conflicts with the current state of the resource');
export const invalidReference = errorResponse(
  'A referenced resource does not exist, is not visible to this account, or belongs to another organisation'
);
export const revisionHasErrors = errorResponse('The revision has errors, so it cannot be served');
export const invalidSignature = errorResponse(
  'The signature is missing, wrong, stale or replayed, its device is unknown, or the body does not match its digest'
);
export const noCaller = errorResponse(
  'No signed-in session was presented, or the device signature is missing, wrong, stale or replayed, its device is unknown, or the body does not match its digest'
);

export const batchTooLarge = errorResponse('The submission is larger than 1 MiB');
