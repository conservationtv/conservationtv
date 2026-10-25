import type { Admission, IncomingPeer } from '@strangecyan/iroh-http-node';
import { z } from 'zod';

// Which peers the agent serves, and whether each may learn its IP addresses. A peer allowed `direct` holepunches to
// the agent; one allowed only `relayed` is served through the relay, its connection accepted without NAT traversal so
// the agent never advertises its addresses to it; anyone else is refused before the handshake.
//
// The decision is made on the endpoint ID the relay authenticated, before the handshake, which then proves the same ID.
//
// TODO: Take the list from the studio API (the organisation's devices, with whether each is trusted to connect
//   directly) rather than from the host.

/** One peer the agent serves, and how it may connect. */
export const PeerSchema = z.object({
  endpointId: z.string().regex(/^[0-9a-f]{64}$/, 'Expected a lowercase hex Ed25519 public key'),
  allow: z.object({
    /** Through the relay, without learning the agent's IP addresses. */
    relayed: z.boolean(),
    /** Holepunching to the agent, learning its IP addresses. */
    direct: z.boolean()
  })
});
export type Peer = z.output<typeof PeerSchema>;

export const PeersSchema = z.array(PeerSchema);
export type Peers = z.output<typeof PeersSchema>;

export function decide(peers: Peers | undefined, peer: IncomingPeer): Admission {
  if (peers === undefined) return 'direct';
  // Over IP the peer is unknown until the handshake, but it already has one of the agent's addresses: nothing is left
  // to hide.
  if (peer.kind === 'ip') return 'direct';
  if (peer.kind !== 'relay') return 'refuse';
  const entry = peers.find(candidate => candidate.endpointId === peer.endpointId);
  if (entry?.allow.direct) return 'direct';
  if (entry?.allow.relayed) return 'relayed';
  return 'refuse';
}
