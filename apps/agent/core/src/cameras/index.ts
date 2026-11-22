import { controller } from '@conservationtv/converge';
import { type CameraControl, CamerasSpecSchema } from './control.ts';
import { CameraProbeRuntime, ProbesSpecSchema } from './runtime.ts';

// The cameras the agent reaches: the `probes` key, asking each its streams come from whether it is there (runtime.ts),
// and the `cameras` key, controlling each for whoever the studio API granted it to (control.ts, grants.ts).
export {
  CameraControl,
  CameraHeld,
  CamerasSpecSchema,
  UnknownCamera,
  useCameraControl,
  withCameraControl,
  type CamerasSpec,
  type CamerasStatus
} from './control.ts';
export { GrantRefused, verifyGrant } from './grants.ts';
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

/** The `cameras` key's runtime, as a converge controller: the agent's one camera control, which its API also calls. */
export function camerasController(control: CameraControl) {
  return controller({
    spec: CamerasSpecSchema,
    status: control.status$,
    execute: spec => control.apply(spec),
    finalize: () => control.teardown(),
    dispose: () => control.dispose()
  });
}
