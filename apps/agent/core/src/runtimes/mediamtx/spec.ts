import { z } from 'zod';
import { MEDIAMTX_RELEASE, mediamtxBinary } from './release.ts';

/** Which MediaMTX to run, and how often to submit its metrics. */
export const MediamtxSpecSchema = z.object({
  mediamtx: mediamtxBinary.schema,
  /** How often to scrape and submit. */
  metricsIntervalMs: z.number().int().min(1_000)
});
export type MediamtxSpec = z.output<typeof MediamtxSpecSchema>;

export const DEFAULT_MEDIAMTX_SPEC: MediamtxSpec = { mediamtx: MEDIAMTX_RELEASE, metricsIntervalMs: 60_000 };
