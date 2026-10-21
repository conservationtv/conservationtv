import { ApiFailure } from '../errors.ts';
import { useEnvironment } from '../env/env.ts';
import { CONNECTION_LIFETIME_SECONDS, provider, type ConnectionAction, type ConnectionRequest } from './provider.ts';

// The built-in conservation.tv gateway: the MoQ relay gatekeeper names, which admits a connection by a token from
// gatekeeper (src/gatekeeper/leases.ts has the same consumer) scoped to the exposure's broadcast.

/** Where an exposure is broadcast on the relay: its own path within its organisation's. */
export const moqPath = (organisationId: string, exposureId: string) => `${organisationId}/${exposureId}`;

/** The exposure's one broadcast under its path, in hang's format: every rendition a track of it. */
export const MOQ_BROADCAST = 'live.hang';

/**
 * What a token admits: everything under the exposure's path, to subscribe, and to publish too for its publisher, which
 * reads back the rendition broadcasts it joins into one.
 */
function moqCapability(path: string, action: ConnectionAction) {
  return { root: path, publish: action === 'publish' ? [''] : [], subscribe: [''] };
}

/** Ask gatekeeper for the token; `gateway_unavailable` if it cannot be reached. */
async function exchange(request: ConnectionRequest, path: string) {
  const environment = useEnvironment();
  const { gatekeeper } = environment;
  try {
    const client = await gatekeeper.client();
    return await client.grants.exchange.v1({
      subject: request.subject,
      requested_capabilities: { moq: moqCapability(path, request.action) },
      expires_in: CONNECTION_LIFETIME_SECONDS
    });
  } catch (cause) {
    throw new ApiFailure('gateway_unavailable', { cause });
  }
}

/** A gatekeeper token for the action at the path. Gatekeeper refusing is never the caller's fault: it is unavailable. */
async function moqToken(request: ConnectionRequest, path: string) {
  const result = await exchange(request, path);
  if (result instanceof Error) throw new ApiFailure('gateway_unavailable', { cause: result });
  const credential = result.credentials.moq;
  if (credential === undefined)
    throw new ApiFailure('gateway_unavailable', { cause: 'Gatekeeper issued no MoQ token' });
  return credential;
}

export const conservationtv = provider.builtin({
  name: 'conservation.tv',
  kind: 'moq-relay',
  // One broadcast carries every rendition of the exposure, as tracks.
  ingest: { moq: 'tracks' },
  egress: { moq: 'tracks' },
  connect: async request => {
    const path = moqPath(request.organisationId, request.exposure.id);
    const credential = await moqToken(request, path);
    return {
      protocol: 'moq',
      relay: credential.relay,
      path,
      broadcast: MOQ_BROADCAST,
      token: credential.token,
      expiresAt: credential.expires_at
    };
  }
});
