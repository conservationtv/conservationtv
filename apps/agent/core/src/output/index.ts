import { join } from 'node:path';
import { controller } from '@conservationtv/converge';
import type { DeviceIdentity } from '@conservationtv/studio-sdk';
import { MEDIAMTX_MANIFEST } from '../binaries/mediamtx.ts';
import { MOQ_MANIFEST } from '../binaries/moq.ts';
import { OBS_MANIFEST } from '../binaries/obs.ts';
import type { CameraCourier } from '../cameras/courier.ts';
import type { AgentConfiguration } from '../config.ts';
import { useStudio } from '../studio.ts';
import { ChannelStatsRuntime, ChannelsSpecSchema } from './channels/runtime.ts';
import { ChatRuntime, ChatSpecSchema } from './chat/runtime.ts';
import { DEFAULT_PROGRAM_PORTS } from './obs/program.ts';
import { ObsRuntime, ObsSpecSchema } from './obs/runtime.ts';
import { ShowRuntime, ShowSpecSchema } from './show/runtime.ts';

// The output: what the agent sends out (docs/outputs.md). Its keys, from the configuration's `obs` and `show` sections
// (configuration.ts):
//
//   obs       an OBS of the agent's own, streaming whatever is on its programme to the program MediaMTX, between it
//             and the channels, previews and recordings it goes to, and the exposures it plays; and the programme's
//             reports (obs/). It drives no scenes;
//   channels  what the channels' platforms say of them, which needs no OBS (channels/);
//   show      the show driving OBS's scenes, while the output follows one (show/). Without it, something outside the
//             studio drives them, or nothing does;
//   chat      the chat of the channels it goes out to or is controlled from, listened to for the standard commands and
//             the organisation's own (chat/), from the configuration's `chat` section as it is.
//
// In obs/: settings.ts says where OBS's configuration lives and what the agent writes there, program.ts the program
// MediaMTX between OBS and everything up- and downstream, inputs.ts how the exposures OBS reads are relayed, watchdog.ts
// what keeps OBS streaming and recording, program-metrics.ts what is reported of the programme, and runtime.ts puts
// them together. In show/: show-stream.ts how the show is followed, ctv-stream.ts how the exposures it places are
// played, and runtime.ts the target driving OBS. The releases they run are in binaries/.

export { outputSpecs, type OutputLeases, type OutputSpecs } from './configuration.ts';
export { ChatSpecSchema, type ChatSpec, type ChatStatus } from './chat/runtime.ts';

/** The port obs-websocket serves on unless the agent's configuration says otherwise: OBS's own. */
export const DEFAULT_OBS_WEBSOCKET_PORT = 4455;

/** The output's runtimes, by the key of the spec each converges to. */
export function outputControllers(config: AgentConfiguration, identity: DeviceIdentity, courier: CameraCourier) {
  const studio = useStudio();
  const obs = new ObsRuntime({
    directory: join(config.directory, 'obs'),
    binary: OBS_MANIFEST,
    moq: MOQ_MANIFEST,
    mediamtx: MEDIAMTX_MANIFEST,
    programPorts: DEFAULT_PROGRAM_PORTS,
    websocketPort: config.obsWebsocketPort ?? DEFAULT_OBS_WEBSOCKET_PORT,
    node: config.node ?? { path: process.execPath },
    studio
  });
  const show = new ShowRuntime(obs, identity);
  const channels = new ChannelStatsRuntime();
  const chat = new ChatRuntime(courier);
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
    }),
    show: controller({
      spec: ShowSpecSchema,
      status: show.status$,
      execute: spec => show.execute(spec),
      finalize: () => show.finalize(),
      dispose: () => show.dispose()
    }),
    chat: controller({
      spec: ChatSpecSchema,
      status: chat.status$,
      execute: spec => chat.apply(spec),
      finalize: () => chat.teardown(),
      dispose: () => chat.dispose()
    })
  };
}
