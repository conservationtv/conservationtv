import type { Camera } from '@conservationtv/studio-sdk';
import { z } from 'zod';

import type { CameraSettingsInput } from '@/forms/schemas';

// What the studio knows about cameras, in words: the drivers it reads them with, the states they can be in, and how a
// camera is reached (apps/studio/api/src/cameras/).

export type CameraDriver = Camera['settings']['driver'];
export type CameraState = Camera['state'];

/** A driver, and what choosing it means. */
interface CameraDriverDetails {
  driver: CameraDriver;
  label: string;
  description: string;
}

/** The drivers a camera is registered with. */
export const CAMERA_DRIVERS = [
  {
    driver: 'axis',
    label: 'Axis',
    description: 'An Axis camera. Each delivery asks it for the size and bitrate it needs.'
  },
  {
    driver: 'rtsp',
    label: 'RTSP',
    description: 'Any camera with an RTSP stream, delivered as it comes.'
  }
] as const satisfies readonly CameraDriverDetails[];

/** A state, and what it means for the camera's streams. */
interface CameraStateDetails {
  state: CameraState;
  label: string;
  description: string;
}

/** The states a camera can be in. Locked and disabled both stop its streams, and for now mean the same. */
export const CAMERA_STATES = [
  { state: 'enabled', label: 'Enabled', description: 'Feeds its streams.' },
  { state: 'locked', label: 'Locked', description: 'Doesn’t feed its streams. For now, the same as disabled.' },
  { state: 'disabled', label: 'Disabled', description: 'Doesn’t feed its streams.' }
] as const satisfies readonly CameraStateDetails[];

/** A driver as a radio's value carries it, to be parsed back into one. */
export const CameraDriverChoiceSchema = z.enum(['axis', 'rtsp']);
export type CameraDriverChoice = z.output<typeof CameraDriverChoiceSchema>;

/** The state a select's value names; undefined for anything else. */
export function cameraStateOf(value: string): CameraState | undefined {
  return CAMERA_STATES.find(candidate => candidate.state === value)?.state;
}

/** What a camera's state is called, and what it means. */
export function cameraStateDetailsOf(state: CameraState): CameraStateDetails {
  return CAMERA_STATES.find(candidate => candidate.state === state) ?? CAMERA_STATES[0];
}

/** What a camera's driver is called. */
export function cameraDriverLabelOf(driver: CameraDriver): string {
  return CAMERA_DRIVERS.find(candidate => candidate.driver === driver)?.label ?? driver;
}

/** Where a camera is reached: an Axis camera's web address, or an RTSP camera's stream. Never its credentials. */
export function cameraAddressOf(settings: Camera['settings']): string {
  return settings.driver === 'axis' ? settings.host : settings.url;
}

/** A camera's stored settings as the settings form starts from them, every driver's fields filled. */
export function cameraSettingsInputOf(settings: Camera['settings']): CameraSettingsInput {
  if (settings.driver === 'rtsp') return { driver: 'rtsp', url: settings.url, host: '', rtspPort: '', resolutions: '' };
  return {
    driver: 'axis',
    host: settings.host,
    rtspPort: settings.rtspPort === undefined ? '' : String(settings.rtspPort),
    resolutions: settings.resolutions.join(', '),
    url: ''
  };
}
