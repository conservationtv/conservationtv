import { BROADCAST_CAMERAS, type BroadcastState } from '@conservationtv/shows';
import { AssetManifestSchema, FramesJsonSchema, type AssetManifest, type Serve } from '@strangecyan/vignette';
import { listStreams } from '../services/streams.ts';
import type { StaticAssets } from '../env/config.ts';
import type { BuiltinGatewayId } from '../gateways/index.ts';

/**
 * What a broadcast is composed from: its state, the show's bundle as served (see `ShowBundle`), and where what targets
 * fetch for it is served.
 */
export interface Presentation extends ShowBundle {
  state: BroadcastState;
  serve: Serve;
}

/**
 * The show's bundle, as this API serves it from its static assets: its assets (the fonts), and the build of its frame page's code,
 * which vignette stamps on every frame source so an open frame page reloads when it changes. No build for a show
 * without frames.
 */
export interface ShowBundle {
  assets: AssetManifest;
  frameBuild?: string;
}

/** An organisation's broadcast, as request handling reaches it: its object (src/shows/host.tsx), by RPC. */
export interface Broadcast {
  /** Set what the broadcast is composed from: compose it, and send it to everyone following it. */
  setComposition(presentation: Presentation): Promise<void>;
  /**
   * Hand a WebSocket upgrade to the broadcast, to follow it, or a frame page's to follow its source
   * (`…/stream?source=`): 404 until it has been composed.
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

/** Where this API serves the show's bundle (`pnpm bundle:show`, packages/shows) from its static assets (contracts/). */
export const SHOW_BUNDLE_PATH = '/show/';

/**
 * Where what the broadcast's targets fetch is served, all by this API: the bundle's assets and frame page, and the
 * stream a frame page follows (narrowed to its own source), at the organisation's broadcast. The stream is a WebSocket
 * (`wss:`, or `ws:` for a local API on `http:`), which is how a frame page knows to follow it by one.
 */
export function broadcastServe(organisationId: string, apiUrl: string): Serve {
  const bundle = new URL(SHOW_BUNDLE_PATH, apiUrl);
  const stream = new URL(`/organisations/${organisationId}/show/stream`, apiUrl);
  stream.protocol = stream.protocol === 'https:' ? 'wss:' : 'ws:';
  return {
    assets: new URL('assets/', bundle).href,
    frames: new URL('frames.html', bundle).href,
    stream: stream.href
  };
}

/**
 * The bundle in the Worker's static assets: the manifest of its assets (`assets.json`), so the composition names the
 * fonts it serves, and its frame build (`frames.json`; none if it is missing or has none). Throws when either cannot
 * be read. The asset server ignores the URL's origin, so the API's own stands in for it.
 */
export async function broadcastBundle(assets: StaticAssets, apiUrl: string): Promise<ShowBundle> {
  const [manifestFile, framesFile] = await Promise.all([
    bundleFile(assets, apiUrl, 'assets.json'),
    bundleFile(assets, apiUrl, 'frames.json')
  ]);
  if (manifestFile === undefined)
    throw new Error("The show's assets.json is not in the static assets: run `pnpm bundle:show`");
  const manifest = AssetManifestSchema.parse(await manifestFile.json());
  const { build } = framesFile === undefined ? {} : FramesJsonSchema.parse(await framesFile.json());
  return build === undefined ? { assets: manifest } : { assets: manifest, frameBuild: build };
}

/** One of the bundle's files from the static assets: `undefined` if there is none. Throws for any other failure. */
async function bundleFile(assets: StaticAssets, apiUrl: string, name: string): Promise<Response | undefined> {
  const url = new URL(name, new URL(SHOW_BUNDLE_PATH, apiUrl));
  const response = await assets.fetch(new Request(url));
  if (response.status === 404) return undefined;
  if (!response.ok)
    throw new Error(`The show's ${name} could not be read from the static assets: HTTP ${response.status}`);
  return response;
}
