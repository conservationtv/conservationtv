import { z } from 'zod';
import { GrantError } from '../errors.ts';
import type { Json } from '@conservationtv/versioned-api/server';
import { EndpointIdSchema, GrantSubjectSchema, MoqPathSchema, MoqRelativePathSchema } from './identifiers.ts';

const MAX_PATHS_PER_ACTION = 32;
/** The longest credential any relay protocol here is issued for, before consumer and environment ceilings. */
export const PROTOCOL_MAX_LIFETIME_SECONDS = 86_400;

const uniquePaths = (paths: string[]) => new Set(paths).size === paths.length;

const MoqPathListSchema = z
  .array(MoqRelativePathSchema)
  .max(MAX_PATHS_PER_ACTION)
  .refine(uniquePaths, 'Duplicate path');
export type MoqPathList = z.output<typeof MoqPathListSchema>;

const MoqRequestSchema = z
  .strictObject({
    root: MoqPathSchema,
    publish: MoqPathListSchema,
    subscribe: MoqPathListSchema
  })
  .refine(moq => moq.publish.length + moq.subscribe.length > 0, 'A MoQ capability must publish or subscribe');
export type MoqRequest = z.output<typeof MoqRequestSchema>;

const IrohRequestSchema = z.strictObject({
  endpoint_id: EndpointIdSchema,
  action: z.literal('connect')
});
export type IrohRequest = z.output<typeof IrohRequestSchema>;

const RequestedCapabilitiesSchema = z
  .strictObject({
    moq: MoqRequestSchema.optional(),
    iroh: IrohRequestSchema.optional()
  })
  .refine(capabilities => capabilities.moq || capabilities.iroh, 'At least one capability is required');
export type RequestedCapabilities = z.output<typeof RequestedCapabilitiesSchema>;

/** Version 1 of the signed grant. Every level is strict: an unknown member could change the meaning of the request. */
const GrantV1Schema = z.strictObject({
  version: z.literal(1),
  subject: GrantSubjectSchema,
  requested_capabilities: RequestedCapabilitiesSchema,
  expires_in: z.int().min(1).max(PROTOCOL_MAX_LIFETIME_SECONDS)
});
export type GrantV1 = z.output<typeof GrantV1Schema>;

const VersionedSchema = z.object({ version: z.json() });
export type Versioned = z.output<typeof VersionedSchema>;

/** Step 6. Unsupported versions are refused outright rather than read as the nearest supported one. */
export function parseGrant(grant: Json): GrantV1 {
  const versioned = VersionedSchema.safeParse(grant);
  if (!versioned.success) throw new GrantError('invalid_grant', { cause: versioned.error });
  if (versioned.data.version !== 1) throw new GrantError('unsupported_grant_version');
  const parsed = GrantV1Schema.safeParse(grant);
  if (!parsed.success) throw new GrantError('invalid_grant', { cause: parsed.error });
  return parsed.data;
}
