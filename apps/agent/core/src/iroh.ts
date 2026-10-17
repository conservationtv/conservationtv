import { Client, DeviceIdentity, deviceSignature, type IrohSession } from '@conservationtv/studio-sdk';
import { Endpoint, RelayMap, RelayMode } from '@number0/iroh';
import { ALPN } from '@strangecyan/iroh-http-node';
import type { AgentConfiguration } from './config.ts';

function relayMode(relays: IrohSession['relays']): RelayMode {
  if (relays.type === 'n0') return RelayMode.defaultMode();
  const map = RelayMap.empty();
  for (const relay of relays.relays) map.insert(relay);
  return RelayMode.custom(map);
}

/**
 * Start an iroh session: ask the studio API, signed as the agent's device, which relays to use, and bind the agent's
 * endpoint with them, accepting HTTP over iroh. The session's details are not kept; the next start asks again.
 */
export async function bindEndpoint(config: AgentConfiguration): Promise<Endpoint> {
  const identity = await DeviceIdentity.fromSecretKey(config.secretKey);
  const studio = new Client({ baseUrl: config.studioUrl, auth: deviceSignature(identity) });
  await studio.handshake();
  const session = await studio.irohSessions.create.v1();
  if (session instanceof Error) throw session;

  const builder = Endpoint.builder();
  builder.applyN0();
  builder.relayMode(relayMode(session.relays));
  builder.secretKey(Array.from(identity.secretKey));
  builder.alpns([ALPN]);
  return builder.bind();
}
