import { Client, deviceSignature, type DeviceIdentity, type IrohSession } from '@conservationtv/studio-sdk';
import { Endpoint, EndpointAddr, EndpointId, RelayMap, RelayMode } from '@number0/iroh';
import { connect, ORIGIN_SUFFIX } from '@strangecyan/iroh-http-node';
import { apiUrl } from './api.js';

/** An open HTTP over iroh connection to one agent, as an SDK's base URL and `fetch`. Disposing it closes it. */
export interface AgentConnection extends AsyncDisposable {
  baseUrl: string;
  fetch: typeof fetch;
}

function parseEndpointId(agent: string) {
  try {
    return EndpointId.fromString(agent);
  } catch (cause) {
    throw new Error(`"${agent}" is not an endpoint id`, { cause });
  }
}

function relayMode(relays: IrohSession['relays']): RelayMode {
  if (relays.type === 'n0') return RelayMode.defaultMode();
  const map = RelayMap.empty();
  for (const relay of relays.relays) map.insert(relay);
  return RelayMode.custom(map);
}

/** Start an iroh session: ask the studio API, signed as the device, which relays to use, and bind an endpoint with them. */
async function bindEndpoint(identity: DeviceIdentity): Promise<Endpoint> {
  const studio = new Client({ baseUrl: apiUrl, auth: deviceSignature(identity) });
  await studio.handshake();
  const session = await studio.irohSessions.create.v1();
  if (session instanceof Error) throw session;

  const builder = Endpoint.builder();
  builder.applyN0();
  builder.relayMode(relayMode(session.relays));
  builder.secretKey(Array.from(identity.secretKey));
  return builder.bind();
}

/**
 * Start an iroh session as the device, and dial the agent with endpoint id `agent`, found through n0's discovery: the
 * agent sees the device's public ID as the request's peer.
 */
export async function connectAgent(agent: string, identity: DeviceIdentity): Promise<AgentConnection> {
  const id = parseEndpointId(agent);
  const address = new EndpointAddr(id);
  // Closed here if connecting fails; handed to the connection if it succeeds.
  await using opened = new AsyncDisposableStack();
  const endpoint = await bindEndpoint(identity);
  opened.defer(() => endpoint.close());
  const client = await connect(endpoint, address);
  opened.defer(() => client.close());
  const owned = opened.move();
  return {
    // The origin the client gives relative targets, so requests built from it go to the same peer.
    baseUrl: `http://${client.peer.endpointId}${ORIGIN_SUFFIX}`,
    fetch: (input, init) => client.fetch(input, init),
    [Symbol.asyncDispose]: () => owned.disposeAsync()
  };
}
