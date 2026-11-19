import { controller } from '@conservationtv/converge';
import { CameraProbeRuntime, ProbesSpecSchema } from './runtime.ts';

// The cameras the agent's streams come from: the `probes` key, asking each whether it is there (runtime.ts).

export { ProbesSpecSchema, type ProbesSpec, type ProbesStatus } from './runtime.ts';

/** The `probes` key's runtime, as a converge controller. */
export function probesController() {
  const probes = new CameraProbeRuntime();
  return controller({
    spec: ProbesSpecSchema,
    status: probes.status$,
    execute: spec => probes.apply(spec),
    finalize: () => probes.teardown(),
    dispose: () => probes.dispose()
  });
}
