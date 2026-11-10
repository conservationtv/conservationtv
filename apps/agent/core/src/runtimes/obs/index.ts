// OBS, managed by the agent for a show it sends out: binaries/ says how OBS is packaged and which release to run,
// settings.ts where its configuration lives and what the agent writes there, show-stream.ts how the show is followed,
// ctv-stream.ts how the streams it places are played, program-metrics.ts what it reports of the program, and
// runtime.ts puts them together as the `obs` key's runtime. What the channels' platforms say of them is reported by a
// key of its own (../channel-stats.ts), which needs no OBS.
export { OBS_MANIFEST, obsBinary, type ObsManifest } from './binaries/obs.ts';
export { DEFAULT_PROGRAM_PORTS, type ProgramPorts } from './program.ts';
export { ObsRuntime, ObsSpecSchema, type ObsRuntimeOptions, type ObsSpec, type ObsStatus } from './runtime.ts';

/** The port obs-websocket serves on unless the agent's configuration says otherwise: OBS's own. */
export const DEFAULT_OBS_WEBSOCKET_PORT = 4455;
