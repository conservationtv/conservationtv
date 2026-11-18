import { getLogger } from '@logtape/logtape';
import { serve, type Admission, type IncomingPeer, type IrohHttpServer } from '@strangecyan/iroh-http-node';
import app from '../api/app.ts';
import type { AgentConfiguration } from '../config.ts';
import { withSystem, type AgentSystem } from '../system/system.ts';
import { decide } from './admission.ts';
import { connectWithEndpoint, createEndpoint } from './endpoint.ts';

const logger = getLogger(['agent']);

/**
 * Serve the agent API as HTTP over iroh, on an endpoint whose identity is the configured secret key, with `system` in
 * scope for every request. Resolves once the endpoint is online and requests are being accepted.
 */
export async function serveOverIroh(config: AgentConfiguration, system: AgentSystem): Promise<IrohHttpServer> {
  const endpoint = await createEndpoint(config);
  await connectWithEndpoint(endpoint);

  const server = serve(
    endpoint,
    (request, peer) => {
      // if (!listed(peer.endpointId)) return new Response(null, { status: 403 });
      return withSystem(system, () => app.fetch(request, { peer: peer.endpointId }));
    },
    {
      admit: (peer: IncomingPeer): Admission => {
        const admission = decide(undefined, peer);
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
