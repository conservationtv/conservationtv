import { MediamtxConfigBuilder } from '@conservationtv/mediamtx';
import type { MediamtxServing } from '../config.ts';
import type { MediamtxPath } from '../paths.ts';

/** MediaMTX's RTSP server, as one of its own paths reads another: its default listener, on loopback. */
const RTSP_LOOPBACK = 'rtsp://127.0.0.1:8554';

/**
 * Each path the spec names, and no other. A path with a `source` pulls it only while someone reads it, so a camera
 * streams nothing nobody watches. With no paths and no auth, any path at all (`all_others`), for a direct agent.
 */
export const paths = new MediamtxConfigBuilder<MediamtxServing>((serving, config) => {
  // Any path when the spec names none and admits anyone; otherwise each it names, pulled from its source while it is
  // read, or (with none) pushed to by its publisher.
  if (serving.paths.length === 0 && serving.auth === undefined) config.paths.all_others = {};
  for (const path of serving.paths) {
    if (path.source === undefined) config.paths[path.name] = {};
    else config.paths[path.name] = { source: sourceUrl(path.source), sourceOnDemand: true };
  }
});

/** Where MediaMTX pulls a path from: its URL, or another of its own paths, read on loopback, which needs no token. */
function sourceUrl(source: NonNullable<MediamtxPath['source']>) {
  return 'url' in source ? source.url : `${RTSP_LOOPBACK}/${source.path}`;
}
