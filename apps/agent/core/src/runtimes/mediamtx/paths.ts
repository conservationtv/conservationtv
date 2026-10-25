import { exposureSubject } from '@conservationtv/reports';
import { z } from 'zod';

// The paths MediaMTX serves, each delivering one of the organisation's exposures. MediaMTX's config has nowhere to keep
// what a path is for, and its metrics name a path only by its name, so the agent keeps that itself: the `metrics`
// spec names each path the `streams` spec serves and what it delivers, from which comes an index from each path's
// name to what its metrics are about.

/** A MediaMTX path name: segments of letters, digits, `_`, `-` and `.`, separated by `/`. */
const PATH_NAME = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u;

/** A path MediaMTX serves, and the exposure it delivers. */
export const MediamtxPathSchema = z.strictObject({
  /** The path's name, which publishers and readers use in its URLs. Never part of its metrics' identity. */
  name: z.string().max(200).regex(PATH_NAME),
  /** The exposure it delivers: its metrics are about `exposure:<id>`. */
  exposureId: z.uuid(),
  /** Which of the exposure's renditions it delivers, by ID, when the exposure has several paths. */
  rendition: z.string().min(1).max(60).optional(),
  /**
   * Where MediaMTX pulls it from while it is read: a URL, such as a camera's RTSP URL, or another of its own paths;
   * none, and publishers push to it.
   */
  source: z
    .union([z.strictObject({ url: z.string().min(1) }), z.strictObject({ path: z.string().regex(PATH_NAME) })])
    .optional()
});
export type MediamtxPath = z.output<typeof MediamtxPathSchema>;

/** What tells one path from another: its name, and what it delivers. */
type PathIdentity = Pick<MediamtxPath, 'name' | 'exposureId' | 'rendition'>;

/** Paths with different names, and each delivering something different: otherwise their metrics would collide. */
function distinct<T extends z.ZodType<PathIdentity>>(path: T) {
  return z
    .array(path)
    .refine(paths => new Set(paths.map(({ name }) => name)).size === paths.length, 'Path names must be unique')
    .refine(
      paths =>
        new Set(paths.map(({ exposureId, rendition }) => `${exposureId}/${rendition ?? ''}`)).size === paths.length,
      'Each path must deliver a different exposure or rendition'
    );
}

export const MediamtxPathsSchema = distinct(MediamtxPathSchema);
export type MediamtxPaths = z.output<typeof MediamtxPathsSchema>;

/** The paths whose metrics are reported, each by its name and the exposure it delivers, but not where it comes from. */
export const PathAttributionsSchema = distinct(
  MediamtxPathSchema.pick({ name: true, exposureId: true, rendition: true })
);
export type PathAttributions = z.output<typeof PathAttributionsSchema>;

/** What a path's metrics are about: a subject, or the agent's device without one, and their dimensions. */
export interface PathTarget {
  subjectId: string | undefined;
  dimensions: Record<string, string>;
}

/**
 * Each path's target, by name, or `null` when the spec names no paths and MediaMTX serves any (`all_others`): then a
 * path's metrics are about the agent's device, with the path as a dimension.
 */
export type PathIndex = Map<string, PathTarget> | null;

export function pathIndexOf(paths: PathAttributions): PathIndex {
  if (paths.length === 0) return null;
  const index = new Map<string, PathTarget>();
  for (const { name, exposureId, rendition } of paths) {
    const dimensions: Record<string, string> = {};
    if (rendition !== undefined) dimensions.rendition = rendition;
    index.set(name, { subjectId: exposureSubject(exposureId), dimensions });
  }
  return index;
}
