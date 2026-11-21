import { Suspense, useEffect, useState, type FC, type ReactNode } from 'react';

import { useCameraCapabilities } from '@/components/cameras/control/camera-capabilities';
import { useCameraControlSession } from '@/components/cameras/control/camera-control-context';
import {
  createDriveStore,
  DriveStoreContext,
  useDriveStore,
  type DriveCamera
} from '@/components/cameras/control/camera-drive-context';
import { lockedBy, positionOf, useCameraStore, type CameraStore } from '@/components/cameras/control/camera-store';

// Driving a camera by hand, whatever it is driven with: the drag on its picture, the joystick, the zoom lever and
// slider, a held button, the arrow keys and a gamepad. Which of them is listened to, what the camera is sent and when,
// and how it took it are all the drive store's (camera-drive-context.ts), which keeps the loop's turning and the
// window's blur listener as effects of its own. All that is here is the part that makes the store, and the part that
// starts and stops its loop. If this browser vanishes mid-move, the camera's agent stops it by its own timeout.

/** What the loop looks at of the camera as it turns: whether another device holds it, and where its zoom is. */
function cameraSightOf(camera: CameraStore): DriveCamera {
  const state = camera.getSnapshot().context;
  const position = positionOf(state);
  return { locked: lockedBy(state) !== null, zoom: position?.zoom };
}

export interface CameraDrivingProps {
  children: ReactNode;
}

/**
 * Drives the camera for the parts beneath it, for as long as it is rendered: they say what they ask for, and the
 * store sends the camera there, through the control session. Its loop waits for the camera's agent to say what the
 * camera can do, and never turns for one that can't be driven.
 */
export const CameraDriving: FC<CameraDrivingProps> = ({ children }) => {
  const control = useCameraControlSession();
  const camera = useCameraStore();
  // The session's `run` sends through the grant as it is when it is called, so a renewed one needs nothing here.
  const run = control.run;
  const [store] = useState(() => createDriveStore({ send: run, camera: () => cameraSightOf(camera) }));
  return (
    <DriveStoreContext value={store}>
      {children}
      <Suspense fallback={null}>
        <DriveLoop />
      </Suspense>
    </DriveStoreContext>
  );
};

/**
 * Starts the loop once the camera's agent has said what the camera can do, and stops it, a camera mid-move with it,
 * when taken away or when that changes. Shows nothing.
 */
const DriveLoop: FC = () => {
  const capabilities = useCameraCapabilities();
  const store = useDriveStore();
  useEffect(() => {
    store.trigger.started({ capabilities });
    return () => store.trigger.stopped();
  }, [store, capabilities]);
  return null;
};
