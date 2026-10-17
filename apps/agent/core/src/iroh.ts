import { Client, DeviceIdentity, deviceSignature, type IrohSession } from '@conservationtv/studio-sdk';
import { Endpoint, RelayMap, RelayMode } from '@number0/iroh';
import { ALPN } from '@strangecyan/iroh-http-node';
import type { AgentConfiguration, ConservationTvConfiguration } from './config.ts';

function relayMode(relays: IrohSession['relays']): RelayMode {
  if (relays.type === 'n0') return RelayMode.defaultMode();
  const map = RelayMap.empty();
  for (const relay of relays.relays) map.insert(relay);
  return RelayMode.custom(map);
}

/** Ask the studio API, signed as the agent's device, for its session. Not kept: the next start asks again. */
async function requestSession(config: ConservationTvConfiguration): Promise<IrohSession> {
  const identity = await DeviceIdentity.fromSecretKey(config.secretKey);
  const studio = new Client({ baseUrl: config.studioUrl, auth: deviceSignature(identity) });
  await studio.handshake();
  const session = await studio.irohSessions.create.v1();
  if (session instanceof Error) throw session;
  return session;
}

/** The session a direct agent was given, or one from the studio API. */
function irohSession(config: AgentConfiguration): Promise<IrohSession> {
  if (config.type === 'direct') return Promise.resolve(config.session);
  return requestSession(config);
}

/** Start an iroh session, and bind the agent's endpoint with its relays, accepting HTTP over iroh. */
export async function bindEndpoint(config: AgentConfiguration): Promise<Endpoint> {
  const session = await irohSession(config);
  const builder = Endpoint.builder();
  builder.applyN0();
  builder.relayMode(relayMode(session.relays));
  builder.secretKey(Array.from(config.secretKey));
  builder.alpns([ALPN]);
  return builder.bind();
}
