import { ApiFailure } from '../errors.ts';
import { useEnvironment } from '../env/env.ts';
import { CONNECTION_LIFETIME_SECONDS, provider, type ConnectionAction, type ConnectionRequest } from './provider.ts';

// The built-in conservation.tv gateway: the MoQ relay gatekeeper names, which admits a connection by a token from
// gatekeeper (src/gatekeeper/leases.ts has the same consumer) scoped to the exposure's broadcast. Without a gatekeeper,
// the deployment's MOQ_RELAY_URL, which admits every connection, so connections carry no token.

/** Where an exposure is broadcast on the relay: its own path within its organisation's. */
export const moqPath = (organisationId: string, exposureId: string) => `${organisationId}/${exposureId}`;

/** What a token admits: the whole broadcast at the path, to publish or to subscribe. */
function moqCapability(path: string, action: ConnectionAction) {
  return { root: path, publish: action === 'publish' ? [''] : [], subscribe: action === 'read' ? [''] : [] };
}

/** Ask gatekeeper for the token; `gateway_unavailable` if it cannot be reached. */
async function exchange(request: ConnectionRequest, path: string) {
  const environment = useEnvironment();
  const gatekeeper = environment.gatekeeper!;
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
  protocols: ['moq'],
  connect: async request => {
    const environment = useEnvironment();
    const path = moqPath(request.organisationId, request.exposure.id);
    if (environment.gatekeeper !== undefined) {
      const credential = await moqToken(request, path);
      return {
        protocol: 'moq',
        relay: credential.relay,
        path,
        token: credential.token,
        expiresAt: credential.expires_at
      };
    }
    const relay = environment.variables.MOQ_RELAY_URL;
    if (relay === undefined) throw new ApiFailure('gateway_unavailable', { cause: 'No gatekeeper or MOQ_RELAY_URL' });
    return { protocol: 'moq', relay, path };
  }
});
