import type { ResolvedAudio, ResolvedVideo } from './resolve.ts';

// Where a broadcast goes, as the pipeline sees it: a sink that takes encoded frames (MoQ, a recording). The sink
// knows nothing of capturing, choosing codecs or sizes, or adapting to the device: it is given renditions already
// resolved, and says only whether it wants each, and how much its network can take.

/** One encoded frame, on the page's clock: microseconds of `performance.now()`, as audio and video share it. */
export interface EncodedFrame {
  data: Uint8Array;
  /** Presentation time in microseconds, `performance.now()`'s epoch (`performance.timeOrigin`). */
  timestamp: number;
  /** Duration in microseconds. */
  duration: number;
  keyframe: boolean;
}

/** What a rendition is being encoded as now: its resolved settings, as adapted to the device and the network. */
export interface Encoding {
  width: number;
  height: number;
  frameRate: number;
  bitrate: number;
}

/** What a sink says back about one rendition. */
export interface RenditionControl {
  /**
   * Whether it wants this rendition encoded: nothing is encoded until some sink does, and encoding stops once none
   * does. A sink that comes to want a rendition already being encoded for another is written to from its next
   * keyframe, and given its decoder config first.
   */
  want(wanted: boolean): void;
  /** The most its network can take for this rendition, in bits per second; undefined for no opinion. */
  limit(bitrate: number | undefined): void;
}

/** A sink's side of one rendition: told what follows, given its frames, and told when encoding stops. */
export interface EncodedTrack<Config> {
  /** The decoder config of the frames that follow, and what they are encoded as. */
  configure(config: Config, encoding: Encoding): void;
  write(frame: EncodedFrame): void;
  /** Encoding has stopped, or is restarting: the next frame written is a keyframe after a gap. */
  cut(): void;
  close(): void;
}

/** A sink taking encoded frames: given each rendition, with the control it answers by. */
export interface EncodedSink {
  readonly kind: 'encoded';
  video(rendition: ResolvedVideo, control: RenditionControl): EncodedTrack<VideoDecoderConfig>;
  audio(rendition: ResolvedAudio, control: RenditionControl): EncodedTrack<AudioDecoderConfig>;
}

/** What a rendition should be encoded at now, for the device and the network: `scale` shrinks each side. */
export interface Target {
  /** An explicit bitrate, or undefined for the rendition's quality's own (Mediabunny's, for the size it encodes). */
  bitrate: number | undefined;
  frameRate: number;
  scale: number;
}

export type BroadcastSink = EncodedSink;
