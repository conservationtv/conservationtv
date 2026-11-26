// Only shared response components live here. Each route declares its input schema inline. Named schemas
// (`meta({ id })`) name the same types wherever they appear in a response.
export { ApiErrorSchema, type ApiError } from '@conservationtv/versioned-api/server';
export { RelaySchema, type Relay } from './topology/iroh.ts';
export {
  ExposurePublisherSchema,
  MediamtxAuthSchema,
  MediamtxTlsSchema,
  PlannedPublisherSchema,
  PreviewConnectSchema,
  PublishedRenditionSchema,
  PublisherConnectSchema,
  StatsConnectSchema,
  WatchConnectSchema,
  WatchedExposureSchema,
  type ExposurePublisher,
  type MediamtxAuth,
  type MediamtxTls,
  type PlannedPublisher,
  type PreviewConnect,
  type PublishedRendition,
  type PublisherConnect,
  type StatsConnect,
  type WatchConnect,
  type WatchedExposure
} from './configuration/plan/types.ts';
export { RenditionSchema, type Rendition } from './topology/renditions.ts';
