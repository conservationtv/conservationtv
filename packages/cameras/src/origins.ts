import type { AxisSettings, CameraCredentials, CameraSettings, Resolution, RtspSettings } from './settings.ts';

// Where each rendition of a camera's stream is pulled from, by its driver. A driver says which renditions the camera
// can produce itself; the others need a publisher that transcodes, which nothing does yet. The agent that reaches the
// camera builds these from its settings and credentials; the studio API still does for agents built before they did.

/**
 * The qualities a stream is delivered at, as the studio API names them (its `RENDITIONS`): `default` is the camera's
 * stream as it comes, which every driver has.
 */
export type CameraRendition = 'default' | 'data_saver' | 'balanced' | 'quality';

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
} satisfies Record<Exclude<CameraRendition, 'default'>, AxisTarget>;

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
function axisOrigin(settings: AxisSettings, credentials: CameraCredentials | undefined, rendition: CameraRendition) {
  // Its RTSP server is on the same host, on its own port (554 unless set), under the same base path (a proxy may serve
  // several cameras, each under its own). Built anew: a web URL's scheme cannot become `rtsp:`.
  const host = new URL(settings.host);
  const base = host.pathname.replace(/\/+$/u, '');
  const url = new URL(`rtsp://${host.hostname}${base}/axis-media/media.amp`);
  if (settings.rtspPort !== undefined) url.port = String(settings.rtspPort);
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
function rtspOrigin(settings: RtspSettings, credentials: CameraCredentials | undefined, rendition: CameraRendition) {
  if (rendition !== 'default') return undefined;
  return withCredentials(new URL(settings.url), credentials);
}

/** Where to pull the rendition from the camera, credentials included; `undefined` when the camera cannot produce it. */
export function cameraOrigin(
  settings: CameraSettings,
  credentials: CameraCredentials | undefined,
  rendition: CameraRendition
): string | undefined {
  switch (settings.driver) {
    case 'axis':
      return axisOrigin(settings, credentials, rendition);
    case 'rtsp':
      return rtspOrigin(settings, credentials, rendition);
  }
}
