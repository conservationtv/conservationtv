import { chatName, type CameraPosition } from '@conservationtv/cameras';
import type { Camera } from '@conservationtv/studio-sdk';
import { z } from 'zod';

import type { CameraSettingsInput } from '@/forms/schemas';
import { API_URL } from '@/lib/auth-client';

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

/**
 * What chat calls a camera: its name and its aliases as chat compares them, without case, spaces or punctuation, each
 * once. `!ptz pondcam` finds the camera called "Pond Cam".
 */
export function cameraChatNamesOf(name: string, aliases: string[]): string[] {
  const names = [name, ...aliases].map(chatName).filter(compared => compared !== '');
  return [...new Set(names)];
}

/** One axis of a position, in words: what it is, and where the camera is on it. */
export interface CameraAxisReading {
  axis: string;
  value: string;
}

/** A position axis by axis, for the axes it has: pan and tilt in degrees, zoom and focus as a share of their range. */
export function cameraAxisReadingsOf(position: CameraPosition): CameraAxisReading[] {
  const readings: CameraAxisReading[] = [];
  if (position.pan !== undefined) readings.push({ axis: 'Pan', value: `${position.pan.toFixed(1)}°` });
  if (position.tilt !== undefined) readings.push({ axis: 'Tilt', value: `${position.tilt.toFixed(1)}°` });
  if (position.zoom !== undefined) readings.push({ axis: 'Zoom', value: `${Math.round(position.zoom * 100)}%` });
  if (position.focus !== undefined) readings.push({ axis: 'Focus', value: `${Math.round(position.focus * 100)}%` });
  return readings;
}

/** A position in a line: "Pan 12.0° · Tilt -3.5° · Zoom 40%". */
export function cameraPositionLineOf(position: CameraPosition): string {
  const readings = cameraAxisReadingsOf(position);
  if (readings.length === 0) return 'No position';
  return readings.map(reading => `${reading.axis} ${reading.value}`).join(' · ');
}

/**
 * Where a preset's thumbnail is read from, or undefined for a preset without one. The address carries the thumbnail's
 * token, which changes whenever the picture does, so the browser keeps each picture for good.
 */
export function presetThumbnailUrlOf(
  organisationId: string,
  cameraId: string,
  preset: Camera['presets'][number]
): string | undefined {
  if (preset.thumbnail === null) return undefined;
  const path = `/organisations/${organisationId}/cameras/${cameraId}/presets/${preset.id}/thumbnail`;
  return `${API_URL}${path}?v=${encodeURIComponent(preset.thumbnail)}`;
}
