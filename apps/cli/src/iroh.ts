import { Client, deviceSignature, type DeviceIdentity } from '@conservationtv/studio-sdk';
import { Endpoint, EndpointAddr, EndpointId, RelayMap, RelayMode } from '@number0/iroh';
import { connect, ORIGIN_SUFFIX } from '@strangecyan/iroh-http-node';

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

/** An iroh session's endpoint, and the relay every device in it is reached through, if there is one. */
interface Session {
  endpoint: Endpoint;
  relayUrl: string | undefined;
}

/**
 * Start an iroh session: ask the studio API, signed as the device, for its relay, and bind an endpoint on it alone,
 * with no address lookup: every device has the same relay, so an agent is found at its endpoint ID there.
 */
async function studioSession(identity: DeviceIdentity, apiUrl: string): Promise<Session> {
  const studio = new Client({ baseUrl: apiUrl, auth: deviceSignature(identity) });
  await studio.handshake();
  const session = await studio.irohSessions.create.v1();
  if (session instanceof Error) throw session;

  const relays = RelayMap.empty();
  relays.insert(session.relay);
  const builder = Endpoint.builder();
  builder.applyMinimal();
  builder.relayMode(RelayMode.custom(relays));
  builder.secretKey(Array.from(identity.secretKey));
  const endpoint = await builder.bind();
  return { endpoint, relayUrl: session.relay.url };
}

/** For direct agents, which use n0's defaults: an endpoint on n0's relays, which looks agents up on n0's DNS server. */
async function directSession(identity: DeviceIdentity): Promise<Session> {
  const builder = Endpoint.builder();
  builder.applyN0();
  builder.secretKey(Array.from(identity.secretKey));
  const endpoint = await builder.bind();
  return { endpoint, relayUrl: undefined };
}

/** A direct agent, found through n0 rather than on the studio's relay. */
export interface DirectAgent {
  direct: true;
}

/** An agent on the relay of the studio API at `apiUrl`. */
export interface StudioAgent {
  direct: false;
  apiUrl: string;
}

export type ConnectOptions = DirectAgent | StudioAgent;

/**
 * Start an iroh session as the device, and dial the agent with endpoint id `agent`: on the session's relay, or for a
 * direct agent, wherever n0's address lookup finds it. The agent sees the device's public ID as the request's peer.
 */
export async function connectAgent(
  agent: string,
  identity: DeviceIdentity,
  options: ConnectOptions
): Promise<AgentConnection> {
  const id = parseEndpointId(agent);
  // Closed here if connecting fails; handed to the connection if it succeeds.
  await using opened = new AsyncDisposableStack();
  const session = options.direct ? directSession(identity) : studioSession(identity, options.apiUrl);
  const { endpoint, relayUrl } = await session;
  opened.defer(() => endpoint.close());
  const address = new EndpointAddr(id, relayUrl);
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
