import { controller, converge } from '@conservationtv/converge';
import { createStore } from '@conservationtv/store';
import type { AgentConfiguration } from './config.ts';
import { MachineRuntime, MachineSpecSchema } from './runtimes/machine.ts';
import { DEFAULT_MEDIAMTX_SPEC, MediamtxRuntime, MediamtxSpecSchema } from './runtimes/mediamtx.ts';

function controllers(config: AgentConfiguration) {
  const machine = new MachineRuntime(config);
  const mediamtx = new MediamtxRuntime(config);
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

export function startSystem(config: AgentConfiguration) {
  return converge({
    controllers: controllers(config),
    restore: async () => ({ machine: { intervalMs: 60_000 }, mediamtx: DEFAULT_MEDIAMTX_SPEC })
  });
}

/** The running agent's system. The host supplies it with each request; handlers read it with `useSystem()`. */
export type AgentSystem = Awaited<ReturnType<typeof startSystem>>;
export const [withSystem, useSystem] = createStore<AgentSystem>('system');
