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

/** An exposure's settings: whatever its gateway reads, beside what the exposure itself declares. */
export const ExposureParamsSchema = z.record(z.string().max(120), z.json());
export type ExposureParams = z.output<typeof ExposureParamsSchema>;
