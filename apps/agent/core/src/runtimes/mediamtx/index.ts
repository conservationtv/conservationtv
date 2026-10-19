// MediaMTX, managed by the agent: binary.ts says how it is packaged and which release to run, paths.ts which paths it
// serves and the exposure each delivers, config.ts what it serves, control.ts how to tell it is up, metrics.ts how its
// metrics reach the studio API, and runtime.ts puts them together with converge's AdoptedProcess as the `mediamtx`
// key's runtime.
export { MEDIAMTX_MANIFEST, mediamtxBinary } from './binary.ts';
export { MediamtxPathSchema, MediamtxPathsSchema, type MediamtxPath, type MediamtxPaths } from './paths.ts';
export {
  MediamtxRuntime,
  MediamtxSpecSchema,
  type MediamtxRuntimeOptions,
  type MediamtxSpec,
  type MediamtxStatus
} from './runtime.ts';
