import type { QualityLevel } from 'mediabunny';

// What a broadcast asks for, before anything is known of the device: the largest picture, what it shows, the ladder
// of sizes sent beside it, and the sound. Nothing here is a choice for the person going live: the presets are the
// whole of it, and `resolve` (src/resolve.ts) fits one to the device and its capture. Each rung is encoded only while
// someone watches it, and readers choose a rung by the size they draw at (docs/shows.md, Sizes), so a ladder costs
// nothing for the sizes nobody watches.

/**
 * What the picture mostly is, as a track's `contentHint` names it: `motion` for a camera (keep the frame rate,
 * soften detail under pressure), `detail` for a screen or a still scene (keep the resolution, drop frames), `text`
 * for slides and code (sharp edges above all).
 */
export type VideoContent = 'motion' | 'detail' | 'text';

/**
 * What the sound mostly is. `speech` keeps the browser's voice processing (echo cancellation, noise suppression,
 * gain), which is right for someone talking with speakers on; `ambient` and `music` turn it all off, since noise
 * suppression takes birdsong, wind and water for noise, and send it in stereo.
 */
export type AudioContent = 'speech' | 'ambient' | 'music';

/** The video codecs a profile can ask for, as Mediabunny names them. */
export type VideoCodecName = 'avc' | 'hevc' | 'vp9' | 'av1' | 'vp8';

/** The audio codecs a profile can ask for, as Mediabunny names them. */
export type AudioCodecName = 'opus' | 'aac';

/**
 * Where encoding may run. `prefer-hardware` tries every codec on the device's encoder before any in software; a
 * software encoder is held to `softwareMaxPixels`, since one at 1080p takes a phone's CPU and battery with it.
 */
export type Acceleration = 'prefer-hardware' | 'prefer-software' | 'no-preference';

/** One picture of the ladder: a name for its sinks, and its size. */
export interface RenditionSpec {
  /** What sinks call it: a MoQ track name. Readers choose by size, never by name. */
  name: string;
  /**
   * Its shorter side at most (its height, held landscape; its width, held upright), never larger than the capture's:
   * the other side follows the capture's shape.
   */
  height: number;
  /** Its quality, where it differs from the profile's. */
  quality?: RungQuality;
}

export type { QualityLevel } from 'mediabunny';

/**
 * A rung's quality, as Mediabunny's `Quality` takes it: a level by name, or a number from 0 (`very-low`) to 1
 * (`very-high`), `high` being 0.75.
 */
export type RungQuality = QualityLevel | number;

export interface VideoProfile {
  /** The largest picture to capture and send: the capture is asked for this, so the camera scales, not the CPU. */
  width: number;
  height: number;
  frameRate: number;
  content: VideoContent;
  /** Codecs to try, best first; the first this device can encode (in hardware, by `acceleration`) is used. */
  codecs: VideoCodecName[];
  acceleration: Acceleration;
  /** The most pixels a software encoder is given, whatever was asked: 1280×720 unless set. */
  softwareMaxPixels?: number;
  /**
   * How good each rung is, as Mediabunny's `Quality` levels it: a bitrate it works out from the rung's pixels and
   * codec (at `high`, about 6 Mb/s for 1080p H.264, 2.8 for 720p, 0.8 for 360p). Every rung's is worked out for its
   * own size, so the one level holds across the ladder.
   */
  quality: QualityLevel;
  /** Seconds between keyframes: how long a viewer joining waits at most, against the bits a keyframe costs. */
  keyframeInterval: number;
  /** The ladder, largest first. Rungs larger than the capture, or barely smaller than the rung above, are dropped. */
  renditions: RenditionSpec[];
}

export interface AudioProfile {
  /** What sinks call it. */
  name: string;
  content: AudioContent;
  codecs: AudioCodecName[];
  /** Bits per second for all channels together. */
  bitrate: number;
  channels: 1 | 2;
  sampleRate: number;
}

/** A broadcast's whole ask: its picture, and its sound if it has one. */
export interface BroadcastProfile {
  video: VideoProfile;
  audio?: AudioProfile;
}

/**
 * A ladder of rungs by their shorter side, named for it. Mediabunny's bitrates grow almost in step with pixels (to the
 * power 0.95), which leaves the smallest rung short of what its text needs: 360 is lifted to 0.85 (about 1 Mb/s, as
 * against 0.76 at `high`): in the broadcast lab (2026-11-26) that put it level with 720 (about 36 dB on the text
 * pattern), where `high` left it 2 to 3 dB below.
 */
function ladder(heights: number[]): RenditionSpec[] {
  return heights.map(height =>
    height <= 360 ? { name: `video/${height}p`, height, quality: 0.85 } : { name: `video/${height}p`, height }
  );
}

/**
 * The sizes slots draw at (1920, 1280, 960 and 640 wide: docs/shows.md, Sizes), each a rung, so every slot gets a
 * picture made for it; a screen adds 1440 and 2160 for full-screen viewers of a large display.
 */
const CAMERA_LADDER = ladder([1080, 720, 540, 360]);
const SCREEN_LADDER = ladder([2160, 1440, 1080, 720, 540, 360]);

/** H.264 first: every phone and computer encodes it in hardware, and every reader and gateway decodes it. */
const CODECS: VideoCodecName[] = ['avc', 'vp9', 'hevc', 'av1'];

/**
 * A camera, on a phone or a computer: up to 1080p30 and the ladder below it, and everything its microphone hears, in
 * stereo, untouched by voice processing (noise suppression takes birdsong, wind and water for noise).
 */
export function cameraProfile(): BroadcastProfile {
  return {
    video: {
      width: 1920,
      height: 1080,
      frameRate: 30,
      content: 'motion',
      quality: 'high',
      codecs: CODECS,
      acceleration: 'prefer-hardware',
      keyframeInterval: 2,
      renditions: CAMERA_LADDER
    },
    audio: {
      name: 'audio/source',
      content: 'ambient',
      codecs: ['opus', 'aac'],
      bitrate: 128_000,
      channels: 2,
      sampleRate: 48_000
    }
  };
}

/**
 * A screen, window or tab: captured at up to 2160p (a larger display is scaled by the capturer, not the CPU) at 30
 * fps, kept sharp rather than smooth, with the ladder below it, and any sound it shares as it is.
 */
export function screenProfile(): BroadcastProfile {
  return {
    video: {
      width: 3840,
      height: 2160,
      frameRate: 30,
      content: 'detail',
      quality: 'high',
      codecs: CODECS,
      acceleration: 'prefer-hardware',
      keyframeInterval: 2,
      renditions: SCREEN_LADDER
    },
    audio: {
      name: 'audio/source',
      content: 'music',
      codecs: ['opus', 'aac'],
      bitrate: 128_000,
      channels: 2,
      sampleRate: 48_000
    }
  };
}
