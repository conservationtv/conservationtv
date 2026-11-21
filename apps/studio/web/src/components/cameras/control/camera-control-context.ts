import { createContext, use } from 'react';
import type { CameraCommand } from '@conservationtv/cameras';

import {
  holderOf,
  holdOf,
  lockedBy,
  selfOf,
  useCamera,
  type CameraHold
} from '@/components/cameras/control/camera-store';
import type { CameraControlSession } from '@/queries/camera-control';

// Controlling a camera is a layer over its page, made of a few things that each do one job. This context says a
// camera is being controlled here: which, the session its commands go through, and how to send one. What is known of
// the camera as it moves is the session's store (camera-store.ts). Driving it by hand (camera-drive-context.ts) and
// taking a still of its picture (camera-picture-context.ts) are layers within the session, each with its own. Parts
// that need the layer do nothing outside it (`useCameraControl` is null there), so a page composes them the same
// whether or not the camera can be controlled just now.

/** The camera being controlled, the session its commands go through, and the way to send it one. */
export interface CameraControlValue {
  cameraId: string;
  session: CameraControlSession;
  /**
   * Tell the camera to do something, through the agent that reaches it (the store's `commanded`). Rejects, saying why
   * in words for whoever is at the controls, if it isn't sent (`CameraLocked`) or the camera or its agent doesn't
   * take it.
   */
  run: (command: CameraCommand) => Promise<void>;
}

export const CameraControlContext = createContext<CameraControlValue | null>(null);

/** The control session this is rendered in, or null where the camera isn't being controlled. */
export function useCameraControl(): CameraControlValue | null {
  return use(CameraControlContext);
}

function outsideControl(): never {
  throw new Error('This is only for components under a camera’s control session (<CameraControl>).');
}

/** The control session this is rendered in, for parts another part has already kept to one. */
export function useCameraControlSession(): CameraControlValue {
  return use(CameraControlContext) ?? outsideControl();
}

/** Who is at the camera's controls, seen from this browser. For parts under a control session. */
export function useCameraHold(): CameraHold {
  const holder = useCamera(holderOf);
  const self = useCamera(selfOf);
  return holdOf(holder, self);
}

/**
 * The device the camera is locked by, by its public ID: another device that holds it, until it is taken over from
 * here. Null while the camera is free to move from this browser. For parts under a control session.
 */
export function useCameraLock(): string | null {
  return useCamera(lockedBy);
}
