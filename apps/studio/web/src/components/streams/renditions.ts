import type { Rendition } from '@conservationtv/studio-sdk';

// The qualities a stream is delivered at: the API's fixed vocabulary (apps/studio/api/src/topology/settings.ts), so a
// reader chooses the same way on every stream. Along a chain, an exposure offers at most what its upstream offers.

/** The built-in gateway every organisation has, by its slug: the only one readers reach over MoQ. */
export const CONSERVATIONTV_GATEWAY = 'conservationtv';

/** Every rendition, in the order they are offered: the source as it comes, then smallest to largest. */
export const RENDITIONS: Rendition[] = ['default', 'data_saver', 'balanced', 'quality'];

export const renditionLabels = {
  default: 'Source',
  data_saver: 'Data saver',
  balanced: 'Balanced',
  quality: 'Quality'
} satisfies Record<Rendition, string>;

/** The part of a camera's settings that says what it can produce. */
interface DriverSettings {
  driver: string;
}

/** The parts of a camera that say what it can produce. */
export interface SourceCamera {
  settings: DriverSettings;
}

/**
 * What a source can produce itself, as its camera's driver says (apps/studio/api/src/cameras/drivers.ts): an Axis
 * camera any rendition, a plain RTSP camera only its stream as it is. Nothing transcodes yet, so that is all an
 * exposure fed by it can offer. Without a camera, whatever publishes it decides, so every rendition is open.
 */
export function sourceRenditions(camera: SourceCamera | undefined): Rendition[] {
  if (camera?.settings.driver === 'rtsp') return ['default'];
  return RENDITIONS;
}

/**
 * The renditions an exposure may offer: what feeds it offers, or what its source produces, and whatever it already
 * offers, so editing never hides a choice that was made before.
 */
export function renditionChoices(available: Rendition[], current: Rendition[] = []): Rendition[] {
  return RENDITIONS.filter(rendition => available.includes(rendition) || current.includes(rendition));
}
