import { join } from 'node:path';
import { type Mutator, controller, converge, mutator } from '@conservationtv/converge';
import { createStore } from '@conservationtv/store';
import type { AgentConfiguration, ConservationTvConfiguration } from './config.ts';
import { MachineRuntime, MachineSpecSchema, type MachineSpec } from './runtimes/machine.ts';
import {
  MEDIAMTX_MANIFEST,
  MediamtxRuntime,
  MediamtxSpecSchema,
  type MediamtxSpec
} from './runtimes/mediamtx/index.ts';
import { watchStudioConfiguration } from './studio-configuration.ts';

function controllers(config: AgentConfiguration) {
  const machine = new MachineRuntime(config);
  const mediamtx = new MediamtxRuntime(config, {
    directory: join(config.directory, 'mediamtx'),
    api: '127.0.0.1:9997',
    metrics: '127.0.0.1:9998',
    authHttp: '127.0.0.1:9996'
  });
  return {
    machine: controller({
      spec: MachineSpecSchema,
      status: machine.status$,
      execute: spec => machine.apply(spec),
      finalize: () => machine.teardown(),
      dispose: () => machine.dispose()
    }),
    mediamtx: controller({
      spec: MediamtxSpecSchema,
      status: mediamtx.status$,
      execute: (spec, signal) => mediamtx.execute(spec, signal),
      finalize: () => mediamtx.finalize(),
      dispose: () => mediamtx.dispose()
    })
  };
}

/** The agent's runtimes, by the key of the spec each converges to. */
export type AgentControllers = ReturnType<typeof controllers>;

/** The spec the system starts from: its keys, each present or absent. */
interface RestoredSpec {
  machine: MachineSpec;
  mediamtx?: MediamtxSpec;
}

/** Every agent watches its machine; a direct agent also runs MediaMTX, serving any path. */
function restored(config: AgentConfiguration): RestoredSpec {
  const spec: RestoredSpec = { machine: { intervalMs: 60_000 } };
  if (config.type === 'direct') {
    spec.mediamtx = { binary: MEDIAMTX_MANIFEST, paths: [], publishers: [], metricsIntervalMs: 60_000 };
  }
  return spec;
}

/**
 * Start converging. A direct agent runs MediaMTX serving any path from the start, changed only through `api`, by
 * requests over iroh. A conservation.tv agent runs it only once its configuration (src/studio-configuration.ts) says
 * it runs a MediaMTX gateway, serving exactly its paths; `api` changes nothing.
 */
export function startSystem(config: AgentConfiguration, api: Mutator<AgentControllers>) {
  return converge({
    controllers: controllers(config),
    restore: async () => restored(config),
    mutator: config.type === 'direct' ? api : studioMutator(config)
  });
}

/** A conservation.tv agent's spec comes from the studio API, which owns its `mediamtx` key. */
function studioMutator(config: ConservationTvConfiguration) {
  return mutator<AgentControllers>(context =>
    watchStudioConfiguration(config, context.signal, spec =>
      context.update(draft => {
        if (spec === undefined) delete draft.mediamtx;
        else draft.mediamtx = spec;
      })
    )
  );
}

/** The running agent's system. The host supplies it with each request; handlers read it with `useSystem()`. */
export type AgentSystem = Awaited<ReturnType<typeof startSystem>>;
export const [withSystem, useSystem] = createStore<AgentSystem>('system');

/**
 * Changes to the spec made by requests over iroh. The host supplies it with each request; handlers read it with
 * `useSpecApi()`. Only a direct agent's system takes them: on any other, `update` rejects with `NotMutating`.
 */
export const [withSpecApi, useSpecApi] = createStore<Mutator<AgentControllers>>('specApi');
