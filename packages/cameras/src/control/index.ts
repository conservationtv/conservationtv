import { NO_CAPABILITIES } from '../contract.ts';
import type { CameraCredentials, CameraSettings } from '../settings.ts';
import { AxisDriver } from './axis.ts';
import { type CameraDriver, UnsupportedCommand } from './driver.ts';

// The drivers that control cameras, one for each kind that can be: Node only, since they call the camera, which only
// the agent on its network reaches.
export { CameraFailure, UnsupportedCommand, type CameraDriver } from './driver.ts';

/** A camera whose driver only reads its stream: it reports nothing, and takes no command. */
const uncontrolled: CameraDriver = {
  capabilities: async () => NO_CAPABILITIES,
  position: async () => ({}),
  options: async () => ({}),
  moveTo: async () => refuse(),
  moveBy: async () => refuse(),
  moveToPoint: async () => refuse(),
  moveToRegion: async () => refuse(),
  drive: async () => refuse(),
  stop: async () => undefined,
  configure: async () => refuse(),
  run: async () => refuse()
};

function refuse(): never {
  throw new UnsupportedCommand('be controlled');
}

/** The driver that controls a camera registered with these settings. */
export function cameraDriver(settings: CameraSettings, credentials: CameraCredentials | undefined): CameraDriver {
  switch (settings.driver) {
    case 'axis':
      return new AxisDriver(settings, credentials);
    case 'rtsp':
      return uncontrolled;
  }
}
