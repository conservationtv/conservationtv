import { setTimeout as sleep } from 'node:timers/promises';
import { Client, DeviceIdentity, deviceSignature, type IrohSession } from '@conservationtv/studio-sdk';
import { Endpoint, RelayMap, RelayMode, type EndpointBuilder } from '@number0/iroh';
import { ALPN } from '@strangecyan/iroh-http-node';
import type { AgentConfiguration, ConservationTvConfiguration } from './config.ts';

// A conservation.tv agent's endpoint uses only its session's relay, with no address lookup: dialers reach it at its
// endpoint ID on that relay, since every device is given the same one. A direct agent uses n0's defaults: its public
// relays, and publishing its address to n0's DNS server for dialers to look up.
//
// TODO: Reconnect and fail over when the relay stops working. iroh reports each home relay's connection state
//   (`Endpoint::home_relay_status`), but the Node binding's `watchHomeRelay` passes only the URLs, dropping
//   `is_connected`; expose it (upstream, or in a fork). Then, disconnected for longer than a threshold, report it
//   through `reports.submit` and ask for a new session, also asking again on the session's own schedule. On a new
//   relay, swap it in place with `insertRelay` and `removeRelay`: the endpoint, its ID and the server stay up.

/** How long the relay gets to accept the endpoint before starting fails: an unreachable relay never says so. */
const ONLINE_TIMEOUT_MS = 15_000;

/** Ask the studio API, signed as the agent's device, for its session. Not kept: the next start asks again. */
async function requestSession(config: ConservationTvConfiguration): Promise<IrohSession> {
  const identity = await DeviceIdentity.fromSecretKey(config.secretKey);
  const studio = new Client({ baseUrl: config.studioUrl, auth: deviceSignature(identity) });
  await studio.handshake();
  const session = await studio.irohSessions.create.v1();
  if (session instanceof Error) throw session;
  return session;
}

/** Resolve once the endpoint is connected to a relay, so it can be dialled; fail if that takes too long. */
async function waitUntilOnline(endpoint: Endpoint, relays: string) {
  const timeout = new AbortController();
  const expired = sleep(ONLINE_TIMEOUT_MS, undefined, { signal: timeout.signal }).then(() => {
    throw new Error(`${relays} did not accept the endpoint within ${ONLINE_TIMEOUT_MS / 1000}s`);
  });
  try {
    await Promise.race([endpoint.online(), expired]);
  } finally {
    timeout.abort();
    expired.catch(() => undefined);
  }
}

/** The endpoint's builder, and the relays it will use, as errors name them. */
interface Plan {
  builder: EndpointBuilder;
  relays: string;
}

/** A conservation.tv agent's endpoint, on its session's relay alone; a direct agent's, with n0's defaults. */
async function plan(config: AgentConfiguration): Promise<Plan> {
  const builder = Endpoint.builder();
  if (config.type === 'direct') {
    builder.applyN0();
    return { builder, relays: "n0's relays" };
  }
  const { relay } = await requestSession(config);
  const relays = RelayMap.empty();
  relays.insert(relay);
  builder.applyMinimal();
  builder.relayMode(RelayMode.custom(relays));
  return { builder, relays: `The relay ${relay.url}` };
}

/** Start an iroh session, and bind the agent's endpoint, accepting HTTP over iroh. */
export async function bindEndpoint(config: AgentConfiguration): Promise<Endpoint> {
  const { builder, relays } = await plan(config);
  builder.secretKey(Array.from(config.secretKey));
  builder.alpns([ALPN]);
  const endpoint = await builder.bind();
  try {
    await waitUntilOnline(endpoint, relays);
  } catch (error) {
    await endpoint.close();
    throw error;
  }
  return endpoint;
}
