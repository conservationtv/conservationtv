import { join } from 'node:path';
import { converge, type Convergence, type SystemSpec } from '@conservationtv/converge';
import type { DeviceIdentity } from '@conservationtv/studio-sdk';
import { createStore } from '@conservationtv/store';
import type { ConservationTvConfiguration } from '../config.ts';
import { gatewayControllers, type GatewaySetup } from '../gateway/index.ts';
import { machineController } from '../machine/index.ts';
import { outputControllers } from '../output/index.ts';
import { REPORT_INTERVAL_MS } from '../reporting/sampler.ts';
import { watchStudioConfiguration } from './configuration.ts';
import { specFile } from './spec-file.ts';

// The agent's system: a converge of its keys, each fulfilled by a runtime.
//
//   machine                            always: the machine the agent runs on (machine/)
//   streams, metrics, relayTraffic     the configuration's `mediamtx` section: the gateway (gateway/)
//   obs, channels, show                the configuration's `obs` and `show` sections: the output it sends out (output/)
//
// It starts from the spec it last accepted, saved in the agent's directory (spec-file.ts), or on a first start from
// `INITIAL_SPEC`; the studio configuration (configuration.ts) then sets each key's spec, or leaves it out, which
// finalises its runtime. Each spec it accepts is saved before it is applied.

/** What the system's runtimes are built from. */
export interface SystemContext {
  config: ConservationTvConfiguration;
  identity: DeviceIdentity;
  gateway: GatewaySetup;
}

/** The agent's runtimes, by the key of the spec each converges to. */
function controllers(context: SystemContext) {
  const { config, identity } = context;
  const machine = machineController(config);
  const gateway = gatewayControllers(config, identity, context.gateway);
  const output = outputControllers(config, identity);
  return {
    machine,
    streams: gateway.streams,
    metrics: gateway.metrics,
    relayTraffic: gateway.relayTraffic,
    obs: output.obs,
    channels: output.channels,
    show: output.show
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
          if (specs.streams === undefined) delete draft.streams;
          else draft.streams = specs.streams;
          if (specs.metrics === undefined) delete draft.metrics;
          else draft.metrics = specs.metrics;
          if (specs.relayTraffic === undefined) delete draft.relayTraffic;
          else draft.relayTraffic = specs.relayTraffic;
          if (specs.obs === undefined) delete draft.obs;
          else draft.obs = specs.obs;
          if (specs.channels === undefined) delete draft.channels;
          else draft.channels = specs.channels;
          if (specs.show === undefined) delete draft.show;
          else draft.show = specs.show;
        })
      )
  });
}
