import { z } from 'zod';

// The JSON stored in the topology's jsonb columns, validated wherever a request supplies it. Field names are the API's,
// so stored values are returned as they are.

/** Settings read by whichever implementation uses them (a protocol or recorder kind). */
export const SettingsSchema = z
  .record(z.string().max(120), z.json())
  .describe('Settings validated by the implementation that reads them.');
export type Settings = z.output<typeof SettingsSchema>;

/** A managed network, or `null` for the public internet. */
export const NetworkReferenceSchema = z
  .uuid()
  .nullable()
  .describe('A network of the organisation, or null for the internet.');
export type NetworkReference = z.output<typeof NetworkReferenceSchema>;

/**
 * The qualities a stream can be delivered at, the same whatever produces them: `default` is the source as it comes,
 * which always exists; the others need a source or publisher that can produce them, which the configuration builders
 * decide. A fixed vocabulary, so readers choose a quality the same way across every stream.
 */
export const RENDITIONS = ['default', 'data_saver', 'balanced', 'quality'] as const;
export const RenditionSchema = z
  .enum(RENDITIONS)
  .describe('A quality the stream is delivered at.')
  .meta({ id: 'Rendition' });
export type Rendition = z.output<typeof RenditionSchema>;

/** The renditions an exposure offers: at least one, each once. */
export const RenditionsSchema = z
  .array(RenditionSchema)
  .min(1)
  .refine(renditions => new Set(renditions).size === renditions.length, 'Renditions must be unique')
  .describe('The renditions the exposure offers.');
export type Renditions = z.output<typeof RenditionsSchema>;

/** An exposure's settings: whatever its gateway reads, beside what the exposure itself declares. */
export const ExposureParamsSchema = z.record(z.string().max(120), z.json());
export type ExposureParams = z.output<typeof ExposureParamsSchema>;
