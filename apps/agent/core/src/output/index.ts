import { join } from 'node:path';
import { controller } from '@conservationtv/converge';
import type { DeviceIdentity } from '@conservationtv/studio-sdk';
import { MEDIAMTX_MANIFEST } from '../binaries/mediamtx.ts';
import { MOQ_MANIFEST } from '../binaries/moq.ts';
import { OBS_MANIFEST } from '../binaries/obs.ts';
import type { AgentConfiguration } from '../config.ts';
import { useStudio } from '../studio.ts';
import { ChannelStatsRuntime, ChannelsSpecSchema } from './channels/runtime.ts';
import { DEFAULT_PROGRAM_PORTS } from './obs/program.ts';
import { ObsRuntime, ObsSpecSchema } from './obs/runtime.ts';

// The output: the show the agent sends out. Its keys, both from the configuration's `obs` section (configuration.ts):
//
//   obs       an OBS of the agent's own following the show, with the program MediaMTX between it and the channels and
//             previews it goes to, and the program's reports (obs/);
//   channels  what the channels' platforms say of them, which needs no OBS (channels/).
//
// In obs/: settings.ts says where OBS's configuration lives and what the agent writes there, show-stream.ts how the
// show is followed, ctv-stream.ts how the streams it places are played, program.ts the program MediaMTX between OBS and
// everything downstream, watchdog.ts what keeps OBS streaming and recording, program-metrics.ts what is reported of the
// program, and runtime.ts puts them together. The releases it runs are in binaries/.

export { outputSpecs, type OutputLeases, type OutputSpecs } from './configuration.ts';

/** The port obs-websocket serves on unless the agent's configuration says otherwise: OBS's own. */
export const DEFAULT_OBS_WEBSOCKET_PORT = 4455;

/** The output's runtimes, by the key of the spec each converges to. */
export function outputControllers(config: AgentConfiguration, identity: DeviceIdentity) {
  const studio = useStudio();
  const obs = new ObsRuntime({
    directory: join(config.directory, 'obs'),
    binary: OBS_MANIFEST,
    moq: MOQ_MANIFEST,
    mediamtx: MEDIAMTX_MANIFEST,
    programPorts: DEFAULT_PROGRAM_PORTS,
    websocketPort: config.obsWebsocketPort ?? DEFAULT_OBS_WEBSOCKET_PORT,
    studio,
    identity
  });
  const channels = new ChannelStatsRuntime();
  return {
    obs: controller({
      spec: ObsSpecSchema,
      status: obs.status$,
      execute: (spec, signal) => obs.execute(spec, signal),
      finalize: () => obs.finalize(),
      dispose: () => obs.dispose()
    }),
    channels: controller({
      spec: ChannelsSpecSchema,
      status: channels.status$,
      execute: spec => channels.apply(spec),
      finalize: () => channels.teardown(),
      dispose: () => channels.dispose()
    })
  };
}
