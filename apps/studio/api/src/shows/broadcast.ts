import type { BroadcastState } from '@conservationtv/shows';
import { AssetManifestSchema, FramesJsonSchema, type AssetManifest, type Serve } from '@strangecyan/vignette';
import type { StaticAssets } from '../env/config.ts';

/**
 * What a broadcast is composed from: its state, the show's bundle as served (see `ShowBundle`), and where what targets
 * fetch for it is served. Not all it depends on: the composition's code does too, which is why its object composes
 * afresh on every sync rather than comparing these (src/shows/host.tsx).
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

/** A show, as request handling reaches it: its object (src/shows/host.tsx), by RPC. */
export interface Broadcast {
  /**
   * Look again: read the show and its streams from the database, compose it, and send what changed to everyone
   * following it. Takes nothing, so no caller can hand it stale state (src/shows/pokes.ts). Never rejects for a sync
   * that failed: that is logged in the object, whose alarm tries again.
   */
  sync(): Promise<void>;
  /**
   * Hand a WebSocket upgrade to the show, to follow it, or a frame page's to follow its source
   * (`…/stream?source=`). The first follow since the object started syncs first; 404 for a show that is not composed.
   */
  fetch(request: Request): Promise<Response>;
}

/** Every show's object, by the show's ID. */
export interface Broadcasts {
  get(showId: string): Broadcast;
}

/** Where this API serves the show's bundle (`pnpm bundle:show`, packages/shows) from its static assets (contracts/). */
export const SHOW_BUNDLE_PATH = '/show/';

/**
 * Where what the broadcast's targets fetch is served, all by this API: the bundle's assets and frame page, and the
 * stream a frame page follows (narrowed to its own source), at the show's. The stream is a WebSocket (`wss:`, or `ws:`
 * for a local API on `http:`), which is how a frame page knows to follow it by one.
 */
export function broadcastServe(organisationId: string, showId: string, apiUrl: string): Serve {
  const bundle = new URL(SHOW_BUNDLE_PATH, apiUrl);
  const stream = new URL(`/organisations/${organisationId}/shows/${showId}/stream`, apiUrl);
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
