// MediaMTX, managed by the agent: binaries/ says how it and moq are packaged and which releases to run, paths.ts
// which paths it serves and the exposure each delivers, config.ts what it serves, auth.ts who it admits, joiner.ts how
// its publishers' renditions become one broadcast, and control.ts how to tell it is up; runtime.ts puts them together
// with converge's AdoptedProcess as the `streams` key's runtime. metrics.ts reads its metrics page for the `metrics`
// key's, shipping them to the studio API.
export { MEDIAMTX_MANIFEST, mediamtxBinary } from './binaries/mediamtx.ts';
export { createMediamtxClient, withMediamtxClient } from './control.ts';
export { MoqPublisherSchema, type MoqPublisher } from './config.ts';
export { MOQ_MANIFEST, moqBinary } from './binaries/moq.ts';
export { MediamtxMetricsRuntime, MetricsSpecSchema, type MetricsSpec, type MetricsStatus } from './metrics.ts';
export {
  MediamtxPathSchema,
  MediamtxPathsSchema,
  PathAttributionsSchema,
  type MediamtxPath,
  type MediamtxPaths,
  type PathAttributions
} from './paths.ts';
export {
  MediamtxRuntime,
  StreamsSpecSchema,
  type MediamtxRuntimeOptions,
  type MediamtxStatus,
  type StreamsSpec
} from './runtime.ts';
