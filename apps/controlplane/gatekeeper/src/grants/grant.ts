import { z } from 'zod';
import {
  EndpointIdSchema,
  fitsStatsPrefix,
  GrantSubjectSchema,
  MoqRelativePathSchema,
  MoqRootSchema
} from './identifiers.ts';

const MAX_PATHS_PER_ACTION = 32;
/** The longest credential any relay protocol here is issued for, before the environment's ceiling. */
export const PROTOCOL_MAX_LIFETIME_SECONDS = 86_400;

const uniquePaths = (paths: string[]) => new Set(paths).size === paths.length;

const MoqPathListSchema = z
  .array(MoqRelativePathSchema)
  .max(MAX_PATHS_PER_ACTION)
  .refine(uniquePaths, 'Duplicate path');
export type MoqPathList = z.output<typeof MoqPathListSchema>;

const MoqRequestSchema = z
  .strictObject({
    /** Relative to the consumer's namespace, which gatekeeper prefixes. */
    root: MoqRootSchema,
    publish: MoqPathListSchema,
    subscribe: MoqPathListSchema,
    /**
     * Read the relays' traffic stats for `root` instead of its broadcasts: the token is rooted at the stats the relays
     * publish for it, `.stats/<namespace>/<root>`, which only ever covers the consumer's own traffic. Read-only.
     */
    stats: z.boolean().default(false)
  })
  .refine(moq => moq.publish.length + moq.subscribe.length > 0, 'A MoQ capability must publish or subscribe')
  .refine(moq => !moq.stats || moq.publish.length === 0, 'Stats are read-only: a stats capability cannot publish')
  .refine(moq => !moq.stats || fitsStatsPrefix(moq.root), 'A stats root must leave room for the stats prefix');
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

/** The grant a consumer asks for. Every level is strict: an unknown member could change the meaning of the request. */
export const GrantSchema = z.strictObject({
  subject: GrantSubjectSchema.describe('Who the credentials are for, recorded for audit, such as `app:device:42`.'),
  requested_capabilities: RequestedCapabilitiesSchema,
  expires_in: z.int().min(1).max(PROTOCOL_MAX_LIFETIME_SECONDS)
});
export type Grant = z.output<typeof GrantSchema>;
