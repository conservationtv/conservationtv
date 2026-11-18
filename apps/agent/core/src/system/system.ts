import { converge, type Convergence } from '@conservationtv/converge';
import type { DeviceIdentity } from '@conservationtv/studio-sdk';
import { createStore } from '@conservationtv/store';
import type { ConservationTvConfiguration } from '../config.ts';
import { gatewayControllers, type GatewaySetup } from '../gateway/index.ts';
import { machineController } from '../machine/index.ts';
import { outputControllers } from '../output/index.ts';
import { watchStudioConfiguration } from './configuration.ts';

// The agent's system: a converge of its keys, each fulfilled by a runtime.
//
//   machine                            always: the machine the agent runs on (machine/)
//   streams, metrics, relayTraffic     the configuration's `mediamtx` section: the gateway (gateway/)
//   obs, channels                      the configuration's `obs` section: the show it sends out (output/)
//
// It starts from a restored spec, and the studio configuration (configuration.ts) then sets each key's spec, or
// leaves it out, which finalises its runtime.

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
    channels: output.channels
  };
}

/** The agent's runtimes, by key: what its system's spec and status are made of. */
export type AgentControllers = ReturnType<typeof controllers>;

/** The running agent's system. The host supplies it with each request; handlers read it with `useSystem()`. */
export type AgentSystem = Convergence<AgentControllers>;
export const [withSystem, useSystem] = createStore<AgentSystem>('system');

/** Converge the runtimes, from the restored spec, to what the studio configuration says from then on. */
export function startSystem(context: SystemContext): Promise<AgentSystem> {
  return converge({
    controllers: controllers(context),
    restore: async () => {
      const spec = {
        machine: { intervalMs: 60_000 },
        streams: { paths: [], previews: [], publishers: [] },
        metrics: { intervalMs: 60_000, paths: [] }
      };
      return spec;
    },
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
        })
      )
  });
}
