import { moqStatsToken, moqToken } from '../gatekeeper/grants.ts';
import { CONNECTION_LIFETIME_SECONDS, provider } from './provider.ts';

// The built-in conservation.tv gateway: the MoQ relay gatekeeper names, which admits a connection by a token from
// gatekeeper (src/gatekeeper/grants.ts) scoped to the delivery's path.
//
// What is live there is what the relay has announced under the organisation's path: moq-relay answers
// `GET /announced/<prefix>?jwt=<token>` on its HTTP listener (the relay's own URL, where HTTPS and QUIC share a port),
// admitting the request as a session of its own, and replies with the active announcements beneath the token's root,
// one path per line, each relative to that root (moq-relay 0.17's `serve_announced`, rs/moq-relay/src/web.rs). A
// delivery is live while the broadcast readers watch, `<delivery>/live.hang`, is announced. Agents from before one
// broadcast carried a delivery announce what it was joined from beside it, which is not what is played.

/** The delivery's one broadcast under its path, in hang's format: its catalog lists the pictures it carries. */
const MOQ_BROADCAST = 'live.hang';

/** How long the token that asks the relay what it has announced lasts: it is used at once, and only once. */
const ANNOUNCED_TOKEN_SECONDS = 60;

/** How long the relay has to answer what it has announced, before it is taken not to be able to say. */
const ANNOUNCED_TIMEOUT_MS = 3_000;

/** What the relay has announced beneath `root`, the token's: each path relative to it. Throws if it cannot say. */
async function announcedPaths(relay: string, root: string, token: string): Promise<Set<string>> {
  const base = relay.endsWith('/') ? relay : `${relay}/`;
  const url = new URL(`announced/${root}`, base);
  url.searchParams.set('jwt', token);
  const response = await fetch(url, { signal: AbortSignal.timeout(ANNOUNCED_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`The relay answered HTTP ${response.status} for what it has announced`);
  const body = await response.text();
  const lines = body.split('\n').map(line => line.trim().replace(/^\/+/u, ''));
  return new Set(lines.filter(line => line !== ''));
}

export const conservationtv = provider.builtin({
  name: 'conservation.tv',
  kind: 'moq-relay',
  ingest: ['moq'],
  egress: ['moq'],
  connect: async request => {
    // Where the exposure or preview is broadcast: its own path within its organisation's, which gatekeeper places
    // beneath this deployment's namespace on the relay, so the credential's root is the path to dial.
    const path = `${request.organisationId}/${request.delivery.id}`;
    const publish = request.action === 'publish';
    const credential = await moqToken(request.subject, path, publish, CONNECTION_LIFETIME_SECONDS);
    return {
      protocol: 'moq',
      relay: credential.relay,
      path: credential.root,
      broadcast: MOQ_BROADCAST,
      token: credential.token,
      expiresAt: credential.expires_at
    };
  },
  // Live while the broadcast readers watch is announced beneath the organisation's path, or a route covering it is.
  live: async request => {
    const credential = await moqToken(request.subject, request.organisationId, false, ANNOUNCED_TOKEN_SECONDS);
    const announced = await announcedPaths(credential.relay, credential.root, credential.token);
    const live = (deliveryId: string) => announced.has(`${deliveryId}/${MOQ_BROADCAST}`) || announced.has(deliveryId);
    return Object.fromEntries(request.deliveryIds.map(deliveryId => [deliveryId, live(deliveryId)]));
  },
  // The relays' stats for everything the organisation's exposures broadcast, beneath its path.
  stats: async request => {
    const credential = await moqStatsToken(request.subject, request.organisationId, CONNECTION_LIFETIME_SECONDS);
    return {
      protocol: 'moq',
      relay: credential.relay,
      path: credential.root,
      token: credential.token,
      expiresAt: credential.expires_at
    };
  }
});
