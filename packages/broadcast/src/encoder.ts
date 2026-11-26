import {
  MediaStreamAudioTrackSource,
  MediaStreamVideoTrackSource,
  Mp4OutputFormat,
  NullTarget,
  Output,
  Quality,
  registerVideoSampleTransformer,
  VideoSample,
  type EncodedPacket,
  type VideoSampleTransformationDescription,
  type VideoEncodingConfig
} from 'mediabunny';

import { rungQuality, type ResolvedAudio, type ResolvedVideo } from './resolve.ts';
import type { EncodedFrame, Encoding, Target } from './sink.ts';

// Encoding a live track with Mediabunny. Mediabunny pulls frames off the track by the best means the browser has (a
// MediaStreamTrackProcessor, in a worker where only a worker has one, or a video element), resizes them, drops them
// rather than queue when the encoder falls behind, works the bitrate out from a quality level, builds the codec
// string the device's encoder wants, and recreates encoders the browser reclaims. Each rung is an Output of its own:
// one Output's tracks are muxed together, and a fragment waits for a keyframe from every track, so a rung nobody
// watches would hold up the rest. Its muxer's fragments are whole GOPs, too late for live, so the Output writes to
// nothing (a `NullTarget`, flushed fragment by fragment, so nothing grows): what is kept is each packet, as it is
// encoded, handed on with its decoder config.
//
// Timestamps are taken from the Unix epoch so every encoder on the page shares one clock however it starts and
// stops (Mediabunny's keyframes fall on whole multiples of the interval on it, so the renditions' line up), and are
// handed on in microseconds of `performance.now()`, the clock MoQ's catalog advertises.

/** What an encoder tells as it goes. */
export interface EncoderOutputs<Config> {
  config: (config: Config, encoding: Encoding) => void;
  frame: (frame: EncodedFrame) => void;
  /** It failed, and has stopped. */
  error: (error: Error) => void;
}

/** A running encoder, stopped once. */
export interface RunningEncoder {
  stop: () => Promise<void>;
}

/** A Unix-epoch time in seconds, as microseconds of `performance.now()`. */
function pageMicros(unixSeconds: number): number {
  return Math.round(unixSeconds * 1e6 - performance.timeOrigin * 1e3);
}

/** A packet as a frame, unless it carries no media (Mediabunny's metadata-only packets). */
function frameOf(packet: EncodedPacket): EncodedFrame | undefined {
  if (packet.isMetadataOnly) return undefined;
  return {
    data: packet.data,
    timestamp: pageMicros(packet.timestamp),
    duration: Math.round(packet.duration * 1e6),
    keyframe: packet.type === 'key'
  };
}

/** A muxer that keeps nothing: fragmented, so each fragment is written to nowhere and let go. */
function discardingOutput(): Output {
  return new Output({
    format: new Mp4OutputFormat({ fastStart: 'fragmented', minimumFragmentDuration: 0.5 }),
    target: new NullTarget()
  });
}

/** Each size's scratch canvas, kept for as long as the page: a ladder uses a handful of sizes, over and over. */
const scratch = new Map<string, OffscreenCanvasRenderingContext2D>();

/** The scratch canvas for `width`×`height`, made the first time. */
function scratchCanvas(width: number, height: number): OffscreenCanvasRenderingContext2D {
  const key = `${width}x${height}`;
  const known = scratch.get(key);
  if (known !== undefined) return known;
  const context = new OffscreenCanvas(width, height).getContext('2d', { alpha: false });
  if (context === null) throw new Error('No 2D canvas to scale frames on.');
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  scratch.set(key, context);
  return context;
}

/** Whether a transformation is a plain downscale of the whole frame, keeping its shape. */
function plainDownscale(sample: VideoSample, description: VideoSampleTransformationDescription): boolean {
  const { crop, width, height } = description;
  const whole =
    crop.left === 0 && crop.top === 0 && crop.width === sample.displayWidth && crop.height === sample.displayHeight;
  const sameAspect = Math.abs(width / height - sample.displayWidth / sample.displayHeight) < 0.01;
  return description.rotation === 0 && !description.flip && whole && sameAspect && width <= sample.displayWidth;
}

/**
 * Mediabunny's resize, for the ladder: the same filtering (halve while more than 2:1 from the size wanted, then one
 * last step of less, since a single bilinear draw past 2:1 skips pixels and breaks up text), on canvases kept per
 * size. Mediabunny's own keeps three canvases for the whole page, and a ladder's rungs need more sizes than that
 * between them, so each frame would make canvases afresh (the broadcast lab, 2026-11-26: three rungs at 2.5 to 3
 * times the CPU). Anything else (rotation, a crop, a change of shape) is left to Mediabunny.
 */
function downscale(sample: VideoSample, description: VideoSampleTransformationDescription): VideoSample | null {
  if (!plainDownscale(sample, description)) return null;
  const frame = sample.toVideoFrame();
  try {
    let source: CanvasImageSource = frame;
    let width = frame.displayWidth;
    let height = frame.displayHeight;
    while (width > 2 * description.width || height > 2 * description.height) {
      width = Math.round(width / 2);
      height = Math.round(height / 2);
      const step = scratchCanvas(width, height);
      step.drawImage(source, 0, 0, width, height);
      source = step.canvas;
    }
    const last = scratchCanvas(description.width, description.height);
    last.drawImage(source, 0, 0, description.width, description.height);
    return new VideoSample(last.canvas, { timestamp: sample.timestamp, duration: sample.duration });
  } finally {
    frame.close();
  }
}

registerVideoSampleTransformer(downscale);

/** How a video encoder is to run: its rendition, and what the governor says to encode it at now. */
export interface VideoEncoderSettings {
  rendition: ResolvedVideo;
  target: Target;
}

/** A size scaled by `scale`, in even numbers, as every encoder takes. */
function scaledSize(width: number, height: number, scale: number): Resize {
  const even = (value: number) => Math.max(2, 2 * Math.round((value * scale) / 2));
  return { width: even(width), height: even(height) };
}

/** A size to encode at. */
interface Resize {
  width: number;
  height: number;
}

/**
 * Start encoding one rung from the capture's own track; resolves once it is running. Every part is Mediabunny's:
 *
 * - `MediaStreamVideoTrackSource` reads the track (each rung its own reader of the one track, so no clones).
 * - `transform` resizes to the rung's size, unless it is the capture's: Mediabunny draws past 2:1 at a power of two
 *   and halves down a mip chain, so text stays whole at any rung.
 * - `Quality` works the bitrate out from the level and the size actually encoded, unless the governor set one.
 * - Frames are not paced (`frameRate: null`): the capture is asked for the rate already, and a screen's frames come
 *   only when it changes, which pacing would pad out with copies. Pressure asks for fewer, by pacing to them.
 * - Keyframes fall on whole multiples of the interval on the Unix clock (`timestampBase: 'unix'`), the same for every
 *   rung, so a reader moving between rungs lands on one.
 */
export async function startVideoEncoder(
  track: MediaStreamVideoTrack,
  settings: VideoEncoderSettings,
  outputs: EncoderOutputs<VideoDecoderConfig>
): Promise<RunningEncoder> {
  const { rendition, target } = settings;
  const size = scaledSize(rendition.width, rendition.height, target.scale);
  const encoding: Encoding = { ...size, frameRate: target.frameRate, bitrate: 0 };
  const captured = track.getSettings();
  const resized = captured.width !== size.width || captured.height !== size.height;
  const config: VideoEncodingConfig = {
    codec: rendition.codec,
    quality:
      target.bitrate === undefined
        ? rungQuality(rendition.quality)
        : new Quality({ bitrate: target.bitrate, bitrateMode: 'variable' }),
    keyFrameInterval: rendition.keyframeInterval,
    latencyMode: 'realtime',
    hardwareAcceleration: rendition.hardware ? 'prefer-hardware' : 'no-preference',
    contentHint: rendition.content,
    onEncoderConfig: encoder => {
      encoding.bitrate = encoder.bitrate ?? 0;
    },
    onEncodedPacket: (packet, meta) => {
      const decoderConfig = meta?.decoderConfig;
      if (decoderConfig !== undefined) outputs.config(decoderConfig, encoding);
      const frame = frameOf(packet);
      if (frame !== undefined) outputs.frame(frame);
    }
  };
  // Resized, every frame is fitted to the rung (a phone turned on its side is letterboxed until the next restart);
  // at the capture's own size, a change of shape is fitted the same way, without a transform otherwise.
  if (resized) config.transform = { ...size, fit: 'contain' };
  else config.sizeChangeBehavior = 'contain';
  const slower = (captured.frameRate ?? target.frameRate) > target.frameRate + 0.5;
  const output = discardingOutput();
  const source = new MediaStreamVideoTrackSource(track, config, {
    frameRate: slower ? target.frameRate : null,
    timestampBase: 'unix'
  });
  source.errorPromise.catch(error => outputs.error(asError(error)));
  output.addVideoTrack(source, { frameRate: target.frameRate, isRelativeToUnixEpoch: true });
  await output.start();
  return { stop: () => output.cancel() };
}

/** Start encoding an audio track; resolves once it is running. */
export async function startAudioEncoder(
  track: MediaStreamAudioTrack,
  rendition: ResolvedAudio,
  outputs: EncoderOutputs<AudioDecoderConfig>
): Promise<RunningEncoder> {
  const output = discardingOutput();
  const encoding: Encoding = { width: 0, height: 0, frameRate: 0, bitrate: rendition.bitrate };
  const source = new MediaStreamAudioTrackSource(
    track,
    {
      codec: rendition.codec,
      quality: new Quality({ bitrate: rendition.bitrate, bitrateMode: 'variable' }),
      transform: { numberOfChannels: rendition.channels, sampleRate: rendition.sampleRate },
      onEncodedPacket: (packet, meta) => {
        const config = meta?.decoderConfig;
        if (config !== undefined) outputs.config(config, encoding);
        const frame = frameOf(packet);
        if (frame !== undefined) outputs.frame(frame);
      }
    },
    { timestampBase: 'unix' }
  );
  source.errorPromise.catch(error => outputs.error(asError(error)));
  output.addAudioTrack(source, { isRelativeToUnixEpoch: true });
  await output.start();
  return { stop: () => output.cancel() };
}

/** What a source's error promise rejected with, as an error: a DOMException or Error, else its text. */
function asError(error: Error | string): Error {
  return error instanceof Error ? error : new Error(error);
}
