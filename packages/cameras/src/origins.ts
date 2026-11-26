import type { AxisSettings, CameraCredentials, CameraSettings, Resolution, RtspSettings } from './settings.ts';

// Where a camera's stream is pulled from, by its driver: the camera's own picture, which every driver has, and a
// smaller one where the camera can encode it itself. A delivery carries the camera's picture, and, where its protocol
// can, smaller ones beside it, which the system decides from what the source can do (docs/shows.md, Delivery):
// nothing asks for a smaller one yet. The agent that reaches the camera builds these from its settings and
// credentials; the studio API still does for agents built before they did.

/** A smaller picture than the camera's own: the largest it has within a width, at most a bitrate. */
export interface CameraRung {
  maxWidth: number;
  maxBitrateKbps: number;
}

/** The URL with the credentials as its userinfo, which RTSP clients such as MediaMTX read. */
function withCredentials(url: URL, credentials: CameraCredentials | undefined) {
  if (credentials === undefined) return url.href;
  url.username = credentials.username;
  url.password = credentials.password;
  return url.href;
}

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
  // Only the largest's aspect ratio, so a smaller picture is never letterboxed apart from the camera's.
  const matching = bySize.filter(size => size.width * largest.height === largest.width * size.height);
  const chosen = matching.find(size => size.width <= maxWidth) ?? matching.at(-1)!;
  return `${chosen.width}x${chosen.height}`;
}

/**
 * An Axis camera's stream: its own settings, in H.264, or a smaller encode it makes per request (VAPIX `resolution`,
 * `videomaxbitrate`). Audio is AAC, which RTMP carries to MoQ publishers, though MediaMTX's WebRTC cannot send it.
 */
function axisOrigin(settings: AxisSettings, credentials: CameraCredentials | undefined, rung?: CameraRung) {
  // Its RTSP server is on the same host, on its own port (554 unless set), under the same base path (a proxy may serve
  // several cameras, each under its own). Built anew: a web URL's scheme cannot become `rtsp:`.
  const host = new URL(settings.host);
  const base = host.pathname.replace(/\/+$/u, '');
  const url = new URL(`rtsp://${host.hostname}${base}/axis-media/media.amp`);
  if (settings.rtspPort !== undefined) url.port = String(settings.rtspPort);
  url.searchParams.set('videocodec', 'h264');
  url.searchParams.set('audiocodec', 'aac');
  if (rung !== undefined) {
    url.searchParams.set('resolution', axisResolution(settings.resolutions, rung.maxWidth));
    url.searchParams.set('videobitratemode', 'mbr');
    url.searchParams.set('videomaxbitrate', String(rung.maxBitrateKbps));
  }
  return withCredentials(url, credentials);
}

/** A plain RTSP camera's one stream, as it is. */
function rtspOrigin(settings: RtspSettings, credentials: CameraCredentials | undefined) {
  return withCredentials(new URL(settings.url), credentials);
}

/** Where to pull the camera's own picture from, credentials included. */
export function cameraOrigin(settings: CameraSettings, credentials: CameraCredentials | undefined): string {
  switch (settings.driver) {
    case 'axis':
      return axisOrigin(settings, credentials);
    case 'rtsp':
      return rtspOrigin(settings, credentials);
  }
}

/**
 * Where to pull a smaller picture the camera encodes itself, credentials included: `undefined` when it cannot, as a
 * plain RTSP camera, which has its one stream.
 */
export function cameraRungOrigin(
  settings: CameraSettings,
  credentials: CameraCredentials | undefined,
  rung: CameraRung
): string | undefined {
  switch (settings.driver) {
    case 'axis':
      return axisOrigin(settings, credentials, rung);
    case 'rtsp':
      return undefined;
  }
}
