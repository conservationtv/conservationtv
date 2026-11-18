import { controller } from '@conservationtv/converge';
import type { AgentConfiguration } from '../config.ts';
import { MachineRuntime, MachineSpecSchema } from './runtime.ts';

// The machine the agent runs on: the `machine` key, which every agent runs, sampling the machine (runtime.ts) and
// reporting where on its network it can be reached (addresses.ts).

/** The `machine` key's runtime, as a converge controller. */
export function machineController(config: AgentConfiguration) {
  const machine = new MachineRuntime(config);
  return controller({
    spec: MachineSpecSchema,
    status: machine.status$,
    execute: spec => machine.apply(spec),
    finalize: () => machine.teardown(),
    dispose: () => machine.dispose()
  });
}
