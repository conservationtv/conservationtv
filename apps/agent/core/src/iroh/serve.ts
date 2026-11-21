import type { DeviceIdentity } from '@conservationtv/studio-sdk';
import { getLogger } from '@logtape/logtape';
import { serve, type Admission, type IncomingPeer, type IrohHttpServer } from '@strangecyan/iroh-http-node';
import app from '../api/app.ts';
import { type CameraControl, withCameraControl } from '../cameras/index.ts';
import type { AgentConfiguration } from '../config.ts';
import { withSystem, type AgentSystem } from '../system/system.ts';
import { decide } from './admission.ts';
import type { AgentDialler } from './dial.ts';
import { connectWithEndpoint, createEndpoint } from './endpoint.ts';
import type { PeerList } from './peers.ts';

const logger = getLogger(['agent']);

/** What the agent API is served with: what its handlers read, and who is admitted to ask. */
export interface Served {
  system: AgentSystem;
  identity: DeviceIdentity;
  cameras: CameraControl;
  /** Who the agent serves: a peer not among them is refused, over the relay before the handshake and anywhere after. */
  peers: PeerList;
  /** Given the endpoint once it is up, to dial other agents from. */
  dialler: AgentDialler;
}

/**
 * Serve the agent API as HTTP over iroh, on an endpoint whose identity is the configured secret key, with the system
 * and the camera control in scope for every request. Resolves once the endpoint is online and requests are being
 * accepted.
 */
export async function serveOverIroh(config: AgentConfiguration, served: Served): Promise<IrohHttpServer> {
  const { system, identity, cameras, peers, dialler } = served;
  const { endpoint, relayUrl } = await createEndpoint(config);
  await connectWithEndpoint(endpoint);
  dialler.attach(endpoint, relayUrl);

  const server = serve(
    endpoint,
    async (request, peer) => {
      // A peer that dialled the agent's address directly was admitted unseen (admission.ts): it is checked here.
      if (!(await peers.admits(peer.endpointId))) return new Response(null, { status: 403 });
      const bindings = { peer: peer.endpointId, identity };
      return withSystem(system, () => withCameraControl(cameras, () => app.fetch(request, bindings)));
    },
    {
      admit: async (peer: IncomingPeer): Promise<Admission> => {
        // A peer on the relay that isn't known may be a browser signed in since the agent last asked: it asks again.
        if (peer.kind === 'relay') await peers.admits(peer.endpointId);
        const admission = decide(peers.current, peer);
        logger.info('Admitted {endpointId} over {kind} as {admission}', {
          kind: peer.kind,
          endpointId: peer.endpointId,
          admission
        });
        return admission;
      }
    }
  );
  const endpointId = endpoint.id();
  logger.info('Started {name} on {endpointId}', { name: config.name, endpointId: endpointId.toString() });
  return server;
}
