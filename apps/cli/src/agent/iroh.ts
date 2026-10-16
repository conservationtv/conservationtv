import { Endpoint, EndpointAddr, EndpointId } from '@number0/iroh';
import { connect, ORIGIN_SUFFIX } from '@strangecyan/iroh-http-node';

/** An open HTTP over iroh connection to one agent, as the SDK's base URL and `fetch`. */
export interface AgentConnection {
  baseUrl: string;
  fetch: typeof fetch;
  close(): Promise<void>;
}

function parseEndpointId(agent: string) {
  try {
    return EndpointId.fromString(agent);
  } catch (cause) {
    throw new Error(`"${agent}" is not an endpoint id`, { cause });
  }
}

/**
 * Dial the agent with endpoint id `agent`, found through n0's discovery, as the endpoint `secretKey` identifies: the
 * agent sees its public half as the request's peer.
 */
export async function connectAgent(agent: string, secretKey: Uint8Array): Promise<AgentConnection> {
  const id = parseEndpointId(agent);
  const address = new EndpointAddr(id);
  const builder = Endpoint.builder();
  builder.applyN0();
  builder.secretKey(Array.from(secretKey));
  const endpoint = await builder.bind();
  try {
    const client = await connect(endpoint, address);
    const peer = client.peer;
    return {
      // The origin the client gives relative targets, so requests built from it go to the same peer.
      baseUrl: `http://${peer.endpointId}${ORIGIN_SUFFIX}`,
      fetch: (input, init) => client.fetch(input, init),
      close: async () => {
        client.close();
        await endpoint.close();
      }
    };
  } catch (error) {
    await endpoint.close();
    throw error;
  }
}
