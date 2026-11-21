import { z } from 'zod';

// What the pointer does on a camera's picture, on this browser: a view preference, kept from one visit to the next.
// As with the pins (src/lib/pins.ts), this module is only the record's format; reading and writing go through the
// this-device queries (src/queries/this-device.ts).

const STORAGE_KEY = 'studio.camera-surface-mode';

/**
 * What a press on the picture means: `steer` drags the camera about, `point` centres it on a spot, `box` fills the
 * picture with a region, and `off` leaves the picture alone.
 */
export const CameraSurfaceModeSchema = z.enum(['steer', 'point', 'box', 'off']);
export type CameraSurfaceMode = z.output<typeof CameraSurfaceModeSchema>;

/** Read the preference; none kept, or one this app doesn't know, is steering. */
export function readCameraSurfaceMode(): CameraSurfaceMode {
  try {
    return CameraSurfaceModeSchema.parse(localStorage.getItem(STORAGE_KEY));
  } catch {
    return 'steer';
  }
}

export function writeCameraSurfaceMode(mode: CameraSurfaceMode): void {
  localStorage.setItem(STORAGE_KEY, mode);
}
