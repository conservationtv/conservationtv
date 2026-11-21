import { createContext, use } from 'react';

import type { PresetPicture } from '@/queries/cameras';

// The camera's picture, as something the control layer can take a still of: for a preset's thumbnail. Whatever shows
// the camera's video (`CameraSurface`) marks itself as the frame the video is in, and whatever wants a still asks
// here, so neither is handed the other's elements.

export interface CameraPictureValue {
  /** A ref for the element the camera's video is shown in. */
  frame: (element: HTMLElement | null) => void;
  /**
   * A still of what the camera shows now, small enough to keep as a thumbnail; null when there is no video to take
   * one from. Throws where the video is there but can't be read.
   */
  capture: () => PresetPicture | null;
}

export const CameraPictureContext = createContext<CameraPictureValue | null>(null);

/** The camera's picture, or null outside a control session: nothing there takes stills. */
export function useCameraPicture(): CameraPictureValue | null {
  return use(CameraPictureContext);
}
