import { z } from 'zod';
import { ApiFailure } from '../errors.ts';

// The named renditions the operation versions released before they were removed speak of (docs/shows.md, Delivery):
// a delivery now carries the one picture its source gives, so those versions answer as if every exposure, preview and
// recorder offered `default` alone, and accept what their clients send, refusing any other rendition as one not
// offered. Nothing else reads this vocabulary.

/** The vocabulary, as those versions' contracts name it. */
export const RENDITIONS = ['default', 'data_saver', 'balanced', 'quality'] as const;
export const RenditionSchema = z
  .enum(RENDITIONS)
  .describe('A quality the stream is delivered at.')
  .meta({ id: 'Rendition' });
export type Rendition = z.output<typeof RenditionSchema>;

/** The renditions an exposure offered: at least one, each once. Accepted, and ignored. */
export const RenditionsSchema = z
  .array(RenditionSchema)
  .min(1)
  .refine(renditions => new Set(renditions).size === renditions.length, 'Renditions must be unique')
  .describe('The renditions the exposure offers.');
export type Renditions = z.output<typeof RenditionsSchema>;

/** What every delivery offers, as those versions say it: its one picture. */
export const ONLY_RENDITION: Rendition = 'default';

/** Refuses a rendition other than the one every delivery offers (`rendition_not_offered`); none is that one. */
export function checkOffered(rendition: Rendition | undefined): Rendition {
  if (rendition !== undefined && rendition !== ONLY_RENDITION) throw new ApiFailure('rendition_not_offered');
  return ONLY_RENDITION;
}

/** An exposure as those versions return it: offering the one rendition. */
export function withRenditions<Exposure extends object>(exposure: Exposure) {
  const renditions: Rendition[] = [ONLY_RENDITION];
  return { ...exposure, renditions };
}

/** A recorder as those versions return it: recording the one rendition. */
export function withRendition<Recorder extends object>(recorder: Recorder) {
  const rendition: Rendition = ONLY_RENDITION;
  return { ...recorder, rendition };
}

/** A stream with its exposures and recorders. */
interface ReleasedStream<Exposure, Recorder> {
  exposures: Exposure[];
  recorders: Recorder[];
}

/** A stream as those versions return it: each exposure and recorder as above. */
export function withStreamRenditions<Exposure extends object, Recorder extends object, Stream extends object>(
  stream: Stream & ReleasedStream<Exposure, Recorder>
) {
  const { exposures, recorders, ...rest } = stream;
  return { ...rest, exposures: exposures.map(withRenditions), recorders: recorders.map(withRendition) };
}
