import { z } from 'zod';

// What a camera is registered with: its settings, chosen by `driver`, and how to authenticate to it. A driver is what
// is known about one kind of camera: where each rendition of its stream is pulled from (origins.ts), and how it is
// controlled (control/). Credentials are kept apart from the settings, encrypted, since members read the settings.

/** How a camera is reached. Kept encrypted, and never returned. */
export const CameraCredentialsSchema = z
  .strictObject({ username: z.string().min(1).max(120), password: z.string().max(256) })
  .describe('How to authenticate to the camera. Write-only: never returned.');
export type CameraCredentials = z.output<typeof CameraCredentialsSchema>;

const ResolutionSchema = z.string().regex(/^\d{2,5}x\d{2,5}$/u, 'A resolution, such as `1280x720`');
export type Resolution = z.output<typeof ResolutionSchema>;

/** An Axis camera, whose RTSP server produces any resolution and bitrate it supports, per request. */
const AxisSettingsSchema = z.strictObject({
  driver: z.literal('axis'),
  /** Where its web server is, as its network reaches it, such as `http://192.168.1.10`. Its RTSP server is beside it. */
  host: z.url(),
  /**
   * Its RTSP server's port (VAPIX `Network.RTSP.Port`), set apart from the web server's on a camera. Default 554.
   */
  rtspPort: z.int().min(1).max(65_535).optional(),
  /** The resolutions it streams, as VAPIX lists them (`Properties.Image.Resolution`). */
  resolutions: z.array(ResolutionSchema).min(1)
});
export type AxisSettings = z.output<typeof AxisSettingsSchema>;

/** Any camera with one RTSP stream, which it produces as it is: only the `default` rendition, and no control. */
const RtspSettingsSchema = z.strictObject({
  driver: z.literal('rtsp'),
  /** Its stream, without credentials. */
  url: z.url()
});
export type RtspSettings = z.output<typeof RtspSettingsSchema>;

export const CameraSettingsSchema = z
  .discriminatedUnion('driver', [AxisSettingsSchema, RtspSettingsSchema])
  .describe('What the camera is registered with: its `driver`, and what that driver reads.');
export type CameraSettings = z.output<typeof CameraSettingsSchema>;
