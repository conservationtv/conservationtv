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

/** A quality an exposure should deliver, identified within the exposure. */
export const RenditionSchema = z.strictObject({
  id: z.string().trim().min(1).max(60),
  width: z.int().positive().max(16_384).optional(),
  height: z.int().positive().max(16_384).optional(),
  bitrate: z.int().positive().describe('Bits per second.').optional()
});
export type Rendition = z.output<typeof RenditionSchema>;

/** An exposure's settings: its desired renditions, and whatever else its protocol reads. */
export const ExposureParamsSchema = z
  .object({ renditions: z.array(RenditionSchema).max(16).optional() })
  .catchall(z.json())
  .refine(
    params => new Set(params.renditions?.map(rendition => rendition.id)).size === (params.renditions?.length ?? 0),
    'Rendition IDs must be unique within the exposure'
  );
export type ExposureParams = z.output<typeof ExposureParamsSchema>;

/** A builder's warning or error about a candidate configuration. Any error makes the candidate unusable. */
export const BuildDiagnosticSchema = z.strictObject({
  severity: z.enum(['warning', 'error']),
  code: z.string().min(1).max(120),
  message: z.string().max(2000),
  target: z.strictObject({ kind: z.string().min(1).max(60), id: z.string().min(1).max(120) }).optional(),
  recovery: z.enum(['retryable', 'change-required']).optional(),
  details: SettingsSchema.optional()
});
export type BuildDiagnostic = z.output<typeof BuildDiagnosticSchema>;
