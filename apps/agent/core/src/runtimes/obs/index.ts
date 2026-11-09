// OBS, managed by the agent for a show it sends out: binaries/ says how OBS is packaged and which release to run,
// settings.ts where its configuration lives and what the agent writes there, show-stream.ts how the show is followed,
// ctv-stream.ts how the streams it places are played, and runtime.ts puts them together as the `obs` key's runtime.
export { OBS_MANIFEST, obsBinary, type ObsManifest } from './binaries/obs.ts';
export { DEFAULT_PROGRAM_PORTS, type ProgramPorts } from './program.ts';
export { ObsRuntime, ObsSpecSchema, type ObsRuntimeOptions, type ObsSpec, type ObsStatus } from './runtime.ts';

/** The port obs-websocket serves on unless the agent's configuration says otherwise: OBS's own. */
export const DEFAULT_OBS_WEBSOCKET_PORT = 4455;
