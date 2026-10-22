// MediaMTX, managed by the agent: binaries/ says how it and moq are packaged and which releases to run, paths.ts
// which paths it serves and the exposure each delivers, config.ts what it serves, auth.ts who it admits, joiner.ts how
// its publishers' renditions become one broadcast, control.ts how to tell it is up, metrics.ts how its metrics reach
// the studio API, and runtime.ts puts them together with converge's AdoptedProcess as the `mediamtx` key's runtime.
export { MEDIAMTX_MANIFEST, mediamtxBinary } from './binaries/mediamtx.ts';
export { createMediamtxClient, withMediamtxClient } from './control.ts';
export { MoqPublisherSchema, type MoqPublisher } from './config.ts';
export { MOQ_MANIFEST, moqBinary } from './binaries/moq.ts';
export { MediamtxPathSchema, MediamtxPathsSchema, type MediamtxPath, type MediamtxPaths } from './paths.ts';
export {
  MediamtxRuntime,
  MediamtxSpecSchema,
  type MediamtxRuntimeOptions,
  type MediamtxSpec,
  type MediamtxStatus
} from './runtime.ts';
