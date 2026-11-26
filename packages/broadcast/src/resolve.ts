import { canEncodeVideo, getFirstEncodableAudioCodec, Quality } from 'mediabunny';

import {
  type AudioCodecName,
  type AudioContent,
  type BroadcastProfile,
  type RungQuality,
  type VideoCodecName,
  type VideoContent,
  type VideoProfile
} from './profile.ts';

// A profile made concrete for this device and this capture: the codec it can encode best (in hardware where it has
// one), and each rendition's size from what the capture actually gives (never larger, always its shape). Bitrates are
// Mediabunny's, from each rung's quality level and size, known once its encoder is configured. Everything after
// this, every sink included, works from the result alone.

/** One picture as it will be sent. */
export interface ResolvedVideo {
  name: string;
  codec: VideoCodecName;
  /** Whether a hardware encoder was found for it; a software one was held to the profile's software size. */
  hardware: boolean;
  width: number;
  height: number;
  frameRate: number;
  /** How good it is: Mediabunny works its bitrate out from this, its size and its codec. */
  quality: RungQuality;
  /** A bitrate in bits per second to encode at instead of the quality's own. */
  bitrate?: number;
  keyframeInterval: number;
  content: VideoContent;
}

/** The sound as it will be sent. */
export interface ResolvedAudio {
  name: string;
  codec: AudioCodecName;
  bitrate: number;
  channels: number;
  sampleRate: number;
  content: AudioContent;
}

/** A broadcast as this device will send it: its renditions, largest first, and its sound. */
export interface ResolvedBroadcast {
  video: ResolvedVideo[];
  audio?: ResolvedAudio;
}

/** Thrown when this browser can encode none of the codecs a profile asks for. */
export class BroadcastUnsupported extends Error {
  constructor(what: 'video' | 'audio') {
    super(`This browser can’t encode ${what} in any of the codecs asked for.`);
    this.name = 'BroadcastUnsupported';
  }
}

/** The most pixels a software encoder is given unless a profile says otherwise: 720p. */
const SOFTWARE_MAX_PIXELS = 1280 * 720;

/** How hard each codec works a CPU in software, least first: the order a software encoder is chosen in. */
const SOFTWARE_COST = { vp8: 0, avc: 1, vp9: 2, hevc: 3, av1: 4 } satisfies Record<VideoCodecName, number>;

/** A picture's size in pixels. */
interface Size {
  width: number;
  height: number;
}

/** A picture's size and frame rate, as captured. */
interface Captured extends Size {
  frameRate: number;
}

/** The codec chosen, whether it encodes in hardware, and the ladder's sizes it encodes. */
interface CodecChoice {
  codec: VideoCodecName;
  hardware: boolean;
  sizes: Rung[];
}

/** A rung of the ladder as resolved: its size, and its quality. */
interface Rung extends Size {
  quality: RungQuality;
}

/** A size that scales `width`×`height` by `scale`, in even numbers, as every encoder takes. */
function scaled(width: number, height: number, scale: number): Size {
  const even = (value: number) => Math.max(2, 2 * Math.round((value * scale) / 2));
  return { width: even(width), height: even(height) };
}

/**
 * The scale that fits a picture within a box of `long`×`short`, whichever way round it is: a phone held upright
 * fits 1920×1080 as 1080×1920, not as a sliver of it.
 */
function fitScale(width: number, height: number, long: number, short: number): number {
  const sourceLong = Math.max(width, height);
  const sourceShort = Math.min(width, height);
  return Math.min(1, long / sourceLong, short / sourceShort);
}

/** The capture's picture: its settings where the browser reports them, else what the profile asked for. */
function captured(track: MediaStreamTrack | undefined, video: VideoProfile): Captured {
  const settings = track?.getSettings() ?? {};
  return {
    width: settings.width ?? video.width,
    height: settings.height ?? video.height,
    frameRate: settings.frameRate ?? video.frameRate
  };
}

/**
 * The ladder's sizes for a capture, largest first: each rung no larger than the profile's box, the capture, or
 * `maxPixels`. A rung barely smaller than the one above it (more than 0.6 of its pixels: a capture smaller than the
 * rung, or the budget) would cost an encoder for nothing a viewer could tell, and is dropped.
 */
function ladderSizes(video: VideoProfile, source: Captured, maxPixels = Number.POSITIVE_INFINITY): Rung[] {
  const long = Math.max(video.width, video.height);
  const short = Math.min(video.width, video.height);
  const sourcePixels = source.width * source.height;
  const scale = Math.min(fitScale(source.width, source.height, long, short), Math.sqrt(maxPixels / sourcePixels));
  const sourceShort = Math.min(source.width, source.height);
  const sizes: Rung[] = [];
  for (const spec of video.renditions) {
    const size = scaled(source.width, source.height, Math.min(scale, spec.height / sourceShort));
    const previous = sizes.at(-1);
    if (previous === undefined || size.width * size.height <= 0.6 * previous.width * previous.height) {
      sizes.push({ ...size, quality: spec.quality ?? video.quality });
    }
  }
  return sizes;
}

/** Whether this device encodes `codec` at a size and rate, where `acceleration` asks. */
function encodes(
  codec: VideoCodecName,
  acceleration: VideoProfile['acceleration'],
  size: Rung,
  frameRate: number
): Promise<boolean> {
  return canEncodeVideo(codec, {
    width: size.width,
    height: size.height,
    frameRate,
    quality: rungQuality(size.quality),
    latencyMode: 'realtime',
    hardwareAcceleration: acceleration
  }).catch(() => false);
}

/**
 * The largest part of the ladder this device encodes in hardware, and the codec: rung by rung from the top, the first
 * codec the profile names that the hardware takes at that size. A PC's encoder that stops at 1080 keeps the rungs
 * from 1080 down in hardware, rather than sending every rung to software for want of the top one.
 */
async function inHardware(video: VideoProfile, sizes: Rung[], frameRate: number): Promise<CodecChoice | undefined> {
  for (const [index, size] of sizes.entries()) {
    for (const codec of video.codecs) {
      if (await encodes(codec, 'prefer-hardware', size, frameRate)) {
        return { codec, hardware: true, sizes: sizes.slice(index) };
      }
    }
  }
  return undefined;
}

/**
 * The codec and the ladder it encodes. Hardware first (unless software is preferred), as `inHardware`; failing that,
 * software, from the cheapest codec up, with every rung held to the software budget, since a software encoder costs
 * in proportion to its pixels; failing that, whatever the browser gives without a preference.
 */
async function chooseCodec(video: VideoProfile, source: Captured, frameRate: number): Promise<CodecChoice | undefined> {
  if (video.acceleration !== 'prefer-software') {
    const hardware = await inHardware(video, ladderSizes(video, source), frameRate);
    if (hardware !== undefined) return hardware;
  }
  const sizes = ladderSizes(video, source, video.softwareMaxPixels ?? SOFTWARE_MAX_PIXELS);
  const [top] = sizes;
  if (top === undefined) return undefined;
  const software = [...video.codecs].sort((a, b) => SOFTWARE_COST[a] - SOFTWARE_COST[b]);
  for (const codec of software) {
    if (await encodes(codec, 'prefer-software', top, frameRate)) return { codec, hardware: false, sizes };
  }
  for (const codec of video.codecs) {
    if (await encodes(codec, 'no-preference', top, frameRate)) return { codec, hardware: false, sizes };
  }
  return undefined;
}

/**
 * A quality level as Mediabunny's `Quality`, always as a bitrate (in variable bitrate): a level may otherwise map to
 * a fixed quantizer, whose bitrate nothing bounds, which a live connection cannot afford.
 */
export function rungQuality(level: RungQuality): Quality {
  return new Quality({ quality: level, preferBitrate: true });
}

/** The renditions of a choice: each rung named for its shorter side, at the frame rate, at the profile's quality. */
function renditions(video: VideoProfile, choice: CodecChoice, frameRate: number): ResolvedVideo[] {
  return choice.sizes.map(size => ({
    name: `video/${Math.min(size.width, size.height)}p`,
    codec: choice.codec,
    hardware: choice.hardware,
    width: size.width,
    height: size.height,
    frameRate,
    quality: size.quality,
    keyframeInterval: video.keyframeInterval,
    content: video.content
  }));
}

/**
 * Resolve a profile for a capture on this device: the codec, each rendition's size, rate and quality, and the sound's
 * codec. Throws `BroadcastUnsupported` where no codec asked for can be encoded.
 */
export async function resolveBroadcast(profile: BroadcastProfile, media: MediaStream): Promise<ResolvedBroadcast> {
  const { video } = profile;
  const [videoTrack] = media.getVideoTracks();
  const source = captured(videoTrack, video);
  // Every rung at the profile's rate (30), or the capture's where it is slower.
  const frameRate = Math.min(video.frameRate, source.frameRate);
  const chosen = await chooseCodec(video, source, frameRate);
  if (chosen === undefined) throw new BroadcastUnsupported('video');
  const resolved: ResolvedBroadcast = { video: renditions(video, chosen, frameRate) };
  const [audioTrack] = media.getAudioTracks();
  if (profile.audio === undefined || audioTrack === undefined) return resolved;
  // As many channels as the microphone gives, up to the profile's: a mono microphone sent as stereo is twice the
  // bits for the same sound.
  const channels = Math.min(profile.audio.channels, audioTrack.getSettings().channelCount ?? profile.audio.channels);
  const { bitrate, sampleRate } = profile.audio;
  const perChannel = channels < profile.audio.channels ? bitrate / profile.audio.channels : bitrate / channels;
  const audioBitrate = Math.round(perChannel * channels);
  const codec = await getFirstEncodableAudioCodec(profile.audio.codecs, {
    numberOfChannels: channels,
    sampleRate,
    quality: new Quality({ bitrate: audioBitrate })
  });
  if (codec !== 'opus' && codec !== 'aac') throw new BroadcastUnsupported('audio');
  resolved.audio = {
    name: profile.audio.name,
    codec,
    bitrate: audioBitrate,
    channels,
    sampleRate,
    content: profile.audio.content
  };
  return resolved;
}
