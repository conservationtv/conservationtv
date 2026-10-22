// Only shared response components live here. Each route declares its input schema inline. Named schemas
// (`meta({ id })`) name the same types wherever they appear in a response.
export { ApiErrorSchema, type ApiError } from '@conservationtv/versioned-api/server';
export { RelaySchema, type Relay } from './topology/iroh.ts';
export {
  MediamtxAuthSchema,
  PlannedPublisherSchema,
  PublishedRenditionSchema,
  PublisherConnectSchema,
  type MediamtxAuth,
  type PlannedPublisher,
  type PublishedRendition,
  type PublisherConnect
} from './configuration/plan/types.ts';
export { RenditionSchema, type Rendition } from './topology/settings.ts';
