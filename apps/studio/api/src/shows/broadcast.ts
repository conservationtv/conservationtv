import { BROADCAST_CAMERAS, type BroadcastState } from '@conservationtv/shows';
import type { Serve } from '@strangecyan/vignette';
import { listStreams } from '../services/streams.ts';
import type { BuiltinGatewayId } from '../gateways/index.ts';

/** What a broadcast is composed from: its state, and where the API serves what targets fetch for it. */
export interface Presentation {
  state: BroadcastState;
  serve: Serve;
}

/** An organisation's broadcast, as request handling reaches it: its object (src/shows/host.ts), by RPC. */
export interface Broadcast {
  /** Set what the broadcast is composed from: compose it, and send it to everyone following it. */
  setComposition(presentation: Presentation): Promise<void>;
  /** Hand a WebSocket upgrade to the broadcast, to follow it: 404 until it has been composed. */
  fetch(request: Request): Promise<Response>;
}

/** Every organisation's broadcast, by the organisation's ID. */
export interface Broadcasts {
  get(organisationId: string): Broadcast;
}

/** The built-in gateway readers reach by MoQ (src/gateways/conservationtv.ts): the only one a broadcast can watch. */
const MOQ_GATEWAY: BuiltinGatewayId = 'conservationtv';

/**
 * A composition for the organisation's broadcast, from its streams as the caller sees them: those delivered to
 * conservation.tv, each at its first exposure there, in a random order, as many as there are slots, maybe none.
 * Random only while it is set by a temporary button; choosing cameras is what a show's controls will do.
 */
export async function shuffledComposition(organisationId: string): Promise<BroadcastState> {
  const streams = await listStreams(organisationId);
  const cameras = streams.flatMap(stream => {
    const exposure = stream.exposures.find(candidate => candidate.gatewayId === MOQ_GATEWAY);
    return exposure ? [{ organisationId, streamId: stream.id, exposureId: exposure.id }] : [];
  });
  return { cameras: shuffled(cameras).slice(0, BROADCAST_CAMERAS) };
}

/** The values in a random order: Fisher–Yates, each place in turn, from the last, taking one not yet placed. */
function shuffled<Value>(values: readonly Value[]): Value[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index--) {
    const other = Math.floor(Math.random() * (index + 1));
    [result[index], result[other]] = [result[other]!, result[index]!];
  }
  return result;
}

/**
 * Where the API serves what the broadcast's targets fetch. Only `assets` for now, and nothing is served there yet: the
 * broadcast names no assets, but vignette asks for the location whenever a show places text, whose `font` may name
 * one (changesbyjames/vignette#28). Targets fetch only what the manifest lists, and it lists nothing.
 */
export function broadcastServe(organisationId: string, apiUrl: string): Serve {
  return { assets: new URL(`/organisations/${organisationId}/show/assets/`, apiUrl).href };
}
