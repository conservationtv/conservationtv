import { join } from 'node:path';
import { converge, type Convergence, type SystemSpec } from '@conservationtv/converge';
import type { DeviceIdentity } from '@conservationtv/studio-sdk';
import { createStore } from '@conservationtv/store';
import { CameraCourier } from '../cameras/courier.ts';
import { type CameraControl, camerasController, probesController } from '../cameras/index.ts';
import type { ConservationTvConfiguration } from '../config.ts';
import { gatewayControllers, type GatewaySetup } from '../gateway/index.ts';
import type { AgentDialler } from '../iroh/dial.ts';
import { type PeerList, peersController } from '../iroh/peers.ts';
import { machineController } from '../machine/index.ts';
import { outputControllers } from '../output/index.ts';
import { REPORT_INTERVAL_MS } from '../reporting/sampler.ts';
import { type StudioSpecs, watchStudioConfiguration } from './configuration.ts';
import { specFile } from './spec-file.ts';

// The agent's system: a converge of its keys, each fulfilled by a runtime.
//
//   machine                            always: the machine the agent runs on (machine/)
//   streams, metrics, relayTraffic     the configuration's `mediamtx` section: the gateway (gateway/)
//   probes                             that section's cameras, each asked whether it is there (cameras/)
//   cameras                            the configuration's `cameras` section: the cameras it controls (cameras/)
//   obs, channels, show                the configuration's `obs` and `show` sections: the output it sends out (output/)
//   chat                               the configuration's `chat` section: the chat it listens to for commands (output/)
//   peers                              the configuration's `peers` section: who it serves over iroh (iroh/)
//
// It starts from the spec it last accepted, saved in the agent's directory (spec-file.ts), or on a first start from
// `INITIAL_SPEC`; the studio configuration (configuration.ts) then sets each key's spec, or leaves it out, which
// finalises its runtime. Each spec it accepts is saved before it is applied.

/** What the system's runtimes are built from. */
export interface SystemContext {
  config: ConservationTvConfiguration;
  identity: DeviceIdentity;
  gateway: GatewaySetup;
  /** The agent's camera control, which its API calls too. */
  cameras: CameraControl;
  /** Who the agent serves, which admission reads. */
  peers: PeerList;
  /** Dials the organisation's other agents, from the agent's endpoint once it is up. */
  dialler: AgentDialler;
}

/** The agent's runtimes, by the key of the spec each converges to. */
function controllers(context: SystemContext) {
  const { config, identity } = context;
  const machine = machineController(config);
  const gateway = gatewayControllers(config, identity, context.gateway);
  const courier = new CameraCourier(identity, context.cameras, context.dialler);
  const output = outputControllers(config, identity, courier);
  return {
    machine,
    streams: gateway.streams,
    metrics: gateway.metrics,
    relayTraffic: gateway.relayTraffic,
    probes: probesController(),
    cameras: camerasController(context.cameras),
    obs: output.obs,
    channels: output.channels,
    show: output.show,
    chat: output.chat,
    peers: peersController(context.peers)
  };
}

/** The agent's runtimes, by key: what its system's spec and status are made of. */
export type AgentControllers = ReturnType<typeof controllers>;

/** The running agent's system. The host supplies it with each request; handlers read it with `useSystem()`. */
export type AgentSystem = Convergence<AgentControllers>;
export const [withSystem, useSystem] = createStore<AgentSystem>('system');

/** Where the spec is saved, in the agent's directory. */
const SPEC_FILE = 'spec.json';

/** The spec of an agent that has none saved: sampling its machine, and MediaMTX up, until the studio says more. */
const INITIAL_SPEC: SystemSpec<AgentControllers> = {
  machine: { intervalMs: REPORT_INTERVAL_MS },
  streams: { paths: [], previews: [], publishers: [] },
  metrics: { intervalMs: REPORT_INTERVAL_MS, paths: [] }
};

/** The keys the studio configuration sets, or leaves out: every one but `machine`, which is the agent's own. */
const STUDIO_KEYS = [
  'streams',
  'metrics',
  'relayTraffic',
  'probes',
  'cameras',
  'obs',
  'channels',
  'show',
  'chat',
  'peers'
] as const satisfies ReadonlyArray<keyof StudioSpecs>;

/** Set the key to its spec in the draft, or remove it when the configuration gave it none. */
function setKey<Key extends (typeof STUDIO_KEYS)[number]>(
  draft: SystemSpec<AgentControllers>,
  specs: StudioSpecs,
  key: Key
): void {
  const spec = specs[key];
  if (spec === undefined) delete draft[key];
  else draft[key] = spec;
}

/** Converge the runtimes, from the spec last saved, to what the studio configuration says from then on. */
export function startSystem(context: SystemContext): Promise<AgentSystem> {
  const runtimes = controllers(context);
  const path = join(context.config.directory, SPEC_FILE);
  const file = specFile(path, runtimes);
  return converge({
    controllers: runtimes,
    restore: async () => {
      const saved = await file.restore();
      if (saved === undefined) return INITIAL_SPEC;
      // The studio never sets `machine`: the agent does, so it samples as this build says to, whatever was saved.
      return { ...saved, machine: INITIAL_SPEC.machine };
    },
    sink: spec => file.sink(spec),
    mutator: mutation =>
      watchStudioConfiguration(mutation.signal, specs =>
        mutation.update(draft => {
          // A runtime the configuration leaves out is finalised: its key is absent.
          for (const key of STUDIO_KEYS) setKey(draft, specs, key);
        })
      )
  });
}
