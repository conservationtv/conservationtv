import { BROADCAST_CAMERAS, type BroadcastState } from '@conservationtv/shows';
import { AssetManifestSchema, type AssetManifest, type Serve } from '@strangecyan/vignette';
import { listStreams } from '../services/streams.ts';
import type { BuiltinGatewayId } from '../gateways/index.ts';

/**
 * What a broadcast is composed from: its state, the assets of the show's bundle (its fonts), and where what targets
 * fetch for it is served.
 */
export interface Presentation {
  state: BroadcastState;
  assets: AssetManifest;
  serve: Serve;
}

/** An organisation's broadcast, as request handling reaches it: its object (src/shows/host.ts), by RPC. */
export interface Broadcast {
  /** Set what the broadcast is composed from: compose it, and send it to everyone following it. */
  setComposition(presentation: Presentation): Promise<void>;
  /**
   * Hand a WebSocket upgrade to the broadcast, to follow it, or a frame page's request for its source's stream
   * (`…/stream?source=`, as server-sent events): 404 until it has been composed.
   */
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
    return exposure ? [{ organisationId, streamId: stream.id, exposureId: exposure.id, name: stream.name }] : [];
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

/** Where the studio web app serves the show's bundle (`vignette bundle`, packages/shows): its frame page and assets. */
const BUNDLE_PATH = '/show/';

/**
 * Where what the broadcast's targets fetch is served: the bundle's assets and frame page by the studio web app, and the
 * stream a frame page follows (narrowed to its own source) by this API, at the organisation's broadcast.
 */
export function broadcastServe(organisationId: string, apiUrl: string, webOrigin: string): Serve {
  const bundle = new URL(BUNDLE_PATH, webOrigin);
  return {
    assets: new URL('assets/', bundle).href,
    frames: new URL('frames.html', bundle).href,
    stream: new URL(`/organisations/${organisationId}/show/stream`, apiUrl).href
  };
}

/**
 * The manifest of the bundle's assets, as the web app serves it beside them, so the composition names the fonts it
 * serves now. Throws when it cannot be read.
 */
export async function broadcastAssets(webOrigin: string): Promise<AssetManifest> {
  const url = new URL('assets.json', new URL(BUNDLE_PATH, webOrigin));
  const response = await fetch(url);
  if (!response.ok) throw new Error(`The show's assets could not be read from ${url.href}: HTTP ${response.status}`);
  return AssetManifestSchema.parse(await response.json());
}
