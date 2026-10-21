import { z } from 'zod';
import type { Rendition } from '../topology/settings.ts';

// A camera driver is what this API knows about one kind of camera: what it is registered with (its settings, chosen
// by `driver`), and where to pull each rendition from, for the configuration builders (src/configuration/). A driver
// says which renditions the camera can produce itself; the others need a publisher that transcodes, which nothing
// does yet. Credentials are kept apart from the settings, encrypted, since members read the settings.

/** How a camera's stream is reached. Kept encrypted, and never returned. */
export const CameraCredentialsSchema = z
  .strictObject({ username: z.string().min(1).max(120), password: z.string().max(256) })
  .describe('How to authenticate to the camera. Write-only: never returned.');
export type CameraCredentials = z.output<typeof CameraCredentialsSchema>;

const ResolutionSchema = z.string().regex(/^\d{2,5}x\d{2,5}$/u, 'A resolution, such as `1280x720`');
type Resolution = z.output<typeof ResolutionSchema>;

/** An Axis camera, whose RTSP server produces any resolution and bitrate it supports, per request. */
const AxisSettingsSchema = z.strictObject({
  driver: z.literal('axis'),
  /** Where its web server is, as its network reaches it, such as `http://192.168.1.10`. Its RTSP server is beside it. */
  host: z.url(),
  /** The resolutions it streams, as VAPIX lists them (`Properties.Image.Resolution`). */
  resolutions: z.array(ResolutionSchema).min(1)
});
type AxisSettings = z.output<typeof AxisSettingsSchema>;

/** Any camera with one RTSP stream, which it produces as it is: only the `default` rendition. */
const RtspSettingsSchema = z.strictObject({
  driver: z.literal('rtsp'),
  /** Its stream, without credentials. */
  url: z.url()
});
type RtspSettings = z.output<typeof RtspSettingsSchema>;

export const CameraSettingsSchema = z
  .discriminatedUnion('driver', [AxisSettingsSchema, RtspSettingsSchema])
  .describe('What the camera is registered with: its `driver`, and what that driver reads.');
export type CameraSettings = z.output<typeof CameraSettingsSchema>;

/** The URL with the credentials as its userinfo, which RTSP clients such as MediaMTX read. */
function withCredentials(url: URL, credentials: CameraCredentials | undefined) {
  if (credentials === undefined) return url.href;
  url.username = credentials.username;
  url.password = credentials.password;
  return url.href;
}

/** What an Axis rendition asks for: the largest resolution the camera has within a size, at most a bitrate. */
interface AxisTarget {
  maxWidth: number;
  maxBitrateKbps: number;
}

const AXIS_TARGETS = {
  quality: { maxWidth: Number.POSITIVE_INFINITY, maxBitrateKbps: 4_000 },
  balanced: { maxWidth: 960, maxBitrateKbps: 1_500 },
  data_saver: { maxWidth: 640, maxBitrateKbps: 500 }
} satisfies Record<Exclude<Rendition, 'default'>, AxisTarget>;

/**
 * The largest of the camera's resolutions within the width, in the aspect ratio of its largest (Axis lists 4:3 and
 * 16:9 alike), or its smallest in that ratio when none is within it.
 */
function axisResolution(resolutions: Resolution[], maxWidth: number) {
  const sizes = resolutions.map(resolution => {
    const [width = 0, height = 0] = resolution.split('x').map(Number);
    return { width, height };
  });
  const bySize = sizes.toSorted((a, b) => b.width - a.width);
  const largest = bySize[0]!;
  // Only the largest's aspect ratio, so one stream's renditions are never letterboxed apart.
  const matching = bySize.filter(size => size.width * largest.height === largest.width * size.height);
  const chosen = matching.find(size => size.width <= maxWidth) ?? matching.at(-1)!;
  return `${chosen.width}x${chosen.height}`;
}

/**
 * An Axis rendition: `default` is the camera's own settings, in H.264; the others are sized and capped per request.
 * Audio is AAC, which RTMP carries to MoQ publishers, though MediaMTX's WebRTC cannot send it.
 */
function axisOrigin(settings: AxisSettings, credentials: CameraCredentials | undefined, rendition: Rendition) {
  // Its RTSP server is on the same host, on RTSP's own port. Built anew: a web URL's scheme cannot become `rtsp:`.
  const url = new URL(`rtsp://${new URL(settings.host).hostname}/axis-media/media.amp`);
  url.searchParams.set('videocodec', 'h264');
  url.searchParams.set('audiocodec', 'aac');
  if (rendition !== 'default') {
    const target = AXIS_TARGETS[rendition];
    url.searchParams.set('resolution', axisResolution(settings.resolutions, target.maxWidth));
    url.searchParams.set('videobitratemode', 'mbr');
    url.searchParams.set('videomaxbitrate', String(target.maxBitrateKbps));
  }
  return withCredentials(url, credentials);
}

/** A plain RTSP camera's only rendition, `default`. */
function rtspOrigin(settings: RtspSettings, credentials: CameraCredentials | undefined, rendition: Rendition) {
  if (rendition !== 'default') return undefined;
  return withCredentials(new URL(settings.url), credentials);
}

/** Where to pull the rendition from the camera, credentials included; `undefined` when the camera cannot produce it. */
export function cameraOrigin(
  settings: CameraSettings,
  credentials: CameraCredentials | undefined,
  rendition: Rendition
): string | undefined {
  switch (settings.driver) {
    case 'axis':
      return axisOrigin(settings, credentials, rendition);
    case 'rtsp':
      return rtspOrigin(settings, credentials, rendition);
  }
}
