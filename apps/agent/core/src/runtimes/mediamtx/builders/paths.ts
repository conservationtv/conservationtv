import { MediamtxConfigBuilder } from '@conservationtv/mediamtx';
import type { MediamtxListening, MediamtxServing } from '../config.ts';
import type { MediamtxPath } from '../paths.ts';

/**
 * Each path the spec names, and no other. A path with a `source` pulls it only while someone reads it, so a camera
 * streams nothing nobody watches. With no paths and no auth, any path at all (`all_others`), for a direct agent. Each
 * show's preview has a path too, which its output pushes the program to.
 */
export const paths = new MediamtxConfigBuilder<MediamtxListening & MediamtxServing>((serving, config) => {
  // Any path when the spec names none and admits anyone; otherwise each it names, pulled from its source while it is
  // read, or (with none) pushed to by its publisher.
  if (serving.paths.length === 0 && serving.auth === undefined) config.paths.all_others = {};
  for (const path of serving.paths) {
    if (path.source === undefined) config.paths[path.name] = {};
    else config.paths[path.name] = { source: sourceUrl(path.source, serving.reach.rtsp), sourceOnDemand: true };
  }
  for (const preview of serving.previews ?? []) config.paths[preview.name] = {};
});

/**
 * Where MediaMTX pulls a path from: its URL, or another of its own paths, read from its own RTSP server (`rtsp`, from
 * reach.ts) as a reader on the same machine, which needs no token.
 */
function sourceUrl(source: NonNullable<MediamtxPath['source']>, rtsp: string) {
  return 'url' in source ? source.url : `${rtsp}/${source.path}`;
}
