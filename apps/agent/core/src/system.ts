import { controller, converge } from '@conservationtv/converge';
import { createStore } from '@conservationtv/store';
import type { AgentConfiguration } from './config.ts';
import { MachineRuntime, MachineSpecSchema } from './runtimes/machine.ts';

function controllers(config: AgentConfiguration) {
  const machine = new MachineRuntime(config);
  return {
    machine: controller({
      spec: MachineSpecSchema,
      status: machine.status$,
      execute: spec => machine.apply(spec),
      finalize: () => machine.teardown(),
      dispose: () => machine.dispose()
    })
  };
}

export function startSystem(config: AgentConfiguration) {
  return converge({
    controllers: controllers(config),
    restore: async () => ({ machine: { intervalMs: 60_000 } })
  });
}

/** The running agent's system. The host supplies it with each request; handlers read it with `useSystem()`. */
export type AgentSystem = Awaited<ReturnType<typeof startSystem>>;
export const [withSystem, useSystem] = createStore<AgentSystem>('system');
