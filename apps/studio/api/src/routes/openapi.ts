import { errorResponse } from '@conservationtv/versioned-api/server';

// The studio API's descriptions of the family's shared failure responses.
export { operationVersion, validator, versionMismatch, webSocket } from '@conservationtv/versioned-api/server';

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
export const endpointRefused = errorResponse(
  "The relay will never admit the device's endpoint: it is denied, or leased to another service"
);
export const inUse = errorResponse('The resource is still used by another resource');
export const conflict = errorResponse('The change conflicts with the current state of the resource');
export const invalidReference = errorResponse(
  'A referenced resource does not exist, is not visible to this account, or belongs to another organisation'
);
export const invalidGateway = errorResponse(
  "The network does not exist or belongs to another organisation, or the settings are not what the gateway's kind reads"
);
export const invalidExposureReference = errorResponse(
  'A referenced resource does not exist, is not visible to this account, or belongs to another organisation'
);
export const exposureInUse = errorResponse('The upstream exposure would lead back to this exposure');
export const invalidRecorderReference = errorResponse(
  'The exposure does not exist, is not visible to this account, or belongs to another stream'
);
/** As `invalidRecorderReference`, for the versions that name a rendition: `default` is the only one offered. */
export const invalidRecorderRendition = errorResponse(
  'The exposure does not exist, is not visible to this account, or belongs to another stream, or the rendition is not `default`, the one every exposure offers'
);
export const invalidSignature = errorResponse(
  'The signature is missing, wrong, stale or replayed, its device is unknown, or the body does not match its digest'
);
export const noCaller = errorResponse(
  'No signed-in session was presented, or the device signature is missing, wrong, stale or replayed, its device is unknown, or the body does not match its digest'
);

export const connectionRefused = errorResponse(
  'The caller may see the exposure but not connect to it like this: members only read, and devices publish what they are the pinned publisher of and read its upstreams'
);
export const unsupportedConnection = errorResponse(
  "Connections to the exposure's gateway are not made through this API, or the gateway is not read or published by that protocol"
);
/** As `unsupportedConnection`, for the version that names a rendition: `default` is the only one offered. */
export const unsupportedConnectionRendition = errorResponse(
  "Connections to the exposure's gateway are not made through this API, the gateway is not read or published by that protocol, or the rendition is not `default`, the one every exposure offers"
);
export const noDelivery = errorResponse(
  "Nothing delivers the stream where the caller can read it, by any protocol it named: no exposure on a gateway it reaches (the internet, or a device's own network) is read by one, or none on the gateway the caller's output reads from"
);
export const streamConnectionRefused = errorResponse(
  "The caller may not connect to the stream like this: an output's agent reads what its show places, or anything of its organisation under `external` control; a member publishes with the right to (`streamPublisher`, which administrators hold), or their browser's own device for them; no other device publishes"
);
export const streamUndeliverable = errorResponse(
  "Reading: nothing delivers the stream where the caller can read it, by any protocol it named (no exposure on a gateway it reaches, the internet or a device's own network, is read by one, or none on the gateway the caller's output reads from). Publishing: no gateway the publisher reaches, the internet or the network it says it is on, is published to by a protocol it named"
);
export const notPushed = errorResponse(
  'The stream comes from a source of its own, such as a camera: only a stream with none is published to'
);
export const notPublisher = errorResponse(
  'The account may see the stream but not publish it: only members holding `streamPublisher` do, which administrators hold'
);
export const noIngest = errorResponse(
  'No gateway that takes an encoder by the stream key is where the encoder says it is (the internet, or the network named), or none of its servers is known'
);
export const unsupportedStats = errorResponse(
  "The gateway publishes no traffic stats through this API: only built-in MoQ relays do, and no organisation's own gateway"
);
export const previewConnectionRefused = errorResponse(
  'The caller may see the preview but not connect to it like this: members only read, and only the agent the output runs on publishes it'
);
export const unsupportedPreviewConnection = errorResponse(
  "Connections to the preview's gateway are not made through this API, or the gateway is not read or published by that protocol"
);
/** As `unsupportedPreviewConnection`, for the version that names a rendition: `default` is the only one offered. */
export const unsupportedPreviewRendition = errorResponse(
  "Connections to the preview's gateway are not made through this API, the gateway is not read or published by that protocol, or the rendition is not `default`, the one a preview offers"
);
export const outputInUse = errorResponse('The agent runs another output: an agent runs one OBS');
export const notOutputDevice = errorResponse('The signing device is not the agent the output runs on');
export const gatewayUnavailable = errorResponse(
  'The database is unavailable, or the gateway is not configured or cannot issue credentials right now'
);

export const channelUnavailable = errorResponse('The channel could not be reached: Twitch refused or did not answer');

export const unsupportedChannelStats = errorResponse(
  'The channel publishes no stats through this API: only Twitch channels do, and no RTMP destination'
);

export const batchTooLarge = errorResponse('The submission is larger than 1 MiB');

export const cameraUnavailable = errorResponse(
  'The database is unavailable, or no agent can control the camera right now: it is not enabled, or its network has no active agent'
);
export const browserRequired = errorResponse(
  'The session has no browser device in the organisation: `organisations.browser.ensure` makes it'
);
export const aliasTaken = errorResponse('Another camera of the organisation is already called by one of the aliases');
export const presetNameTaken = errorResponse('The camera already has a preset of that name');
export const commandNameTaken = errorResponse('The organisation already has a command used by that word');
export const notOutputAgent = errorResponse(
  'The signing device is not an agent an output runs on, or its output does not go out to the channel'
);
export const invalidReceipt = errorResponse(
  'The request is malformed, or its receipt is forged, lapsed, or for another use or device'
);
