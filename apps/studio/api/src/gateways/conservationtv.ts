import { moqToken } from '../gatekeeper/grants.ts';
import { CONNECTION_LIFETIME_SECONDS, provider } from './provider.ts';

// The built-in conservation.tv gateway: the MoQ relay gatekeeper names, which admits a connection by a token from
// gatekeeper (src/gatekeeper/grants.ts) scoped to the exposure's path.

/** The exposure's one broadcast under its path, in hang's format: every rendition a track of it. */
const MOQ_BROADCAST = 'live.hang';

export const conservationtv = provider.builtin({
  name: 'conservation.tv',
  kind: 'moq-relay',
  // One broadcast carries every rendition of the exposure, as tracks.
  ingest: { moq: 'tracks' },
  egress: { moq: 'tracks' },
  connect: async request => {
    // Where the exposure is broadcast on the relay: its own path within its organisation's.
    const path = `${request.organisationId}/${request.exposure.id}`;
    const publish = request.action === 'publish';
    const credential = await moqToken(request.subject, path, publish, CONNECTION_LIFETIME_SECONDS);
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
