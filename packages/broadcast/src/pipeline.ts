import { startAudioEncoder, startVideoEncoder, type EncoderOutputs, type RunningEncoder } from './encoder.ts';
import { Governor, watchPressure } from './governor.ts';
import type { ResolvedAudio, ResolvedBroadcast, ResolvedVideo } from './resolve.ts';
import type { BroadcastSink, EncodedFrame, EncodedTrack, Encoding, RenditionControl } from './sink.ts';

// The pipeline: a capture and its resolved broadcast, sent to any number of sinks. Each rendition is a lane: a
// Mediabunny encoder of the capture's track at the rung's size (src/encoder.ts), run only while some sink wants it,
// at what its governor says the device and the network can take now, each frame fanned out to every sink that wants
// it, from a keyframe. What is left here is what Mediabunny has no part in: when each rung runs, and who gets it.

export interface PipelineOptions {
  /** Whether to adapt to the network's ceiling and the CPU's pressure; on unless turned off. */
  adapt?: boolean;
  /** Told when a rendition's encoder fails; it is tried again shortly while still wanted. */
  onError?: (error: Error, rendition: string) => void;
}

/** How long to wait before starting an encoder again after it failed. */
const RETRY_MS = 2_000;

/** One sink's hold on a lane. */
interface Consumer<Config> {
  track: EncodedTrack<Config> | undefined;
  wanted: boolean;
  limit: number | undefined;
  /** Whether it has been given a keyframe since encoding last (re)started, and so is written to. */
  synced: boolean;
}

/** The decoder config of what is being encoded now, and what it is encoded as. */
interface CurrentConfig<Config> {
  config: Config;
  encoding: Encoding;
}

/**
 * One rendition's encoder and the sinks it feeds: started while wanted, restarted when its target changes, and
 * stopped when nobody wants it. Changes are made one at a time, from the state wanted when each is made.
 */
abstract class Lane<Config> {
  abstract readonly name: string;
  protected readonly consumers = new Set<Consumer<Config>>();
  private running: RunningEncoder | undefined = undefined;
  private runningVersion = -1;
  /** Which encoder is the current one; bumped whenever one stops or fails. */
  private generation = 0;
  /** Bumped whenever the running encoder no longer matches what is wanted, so the next pass restarts it. */
  protected version = 0;
  private busy = false;
  private again = false;
  private isClosed = false;
  private retryTimer: ReturnType<typeof setTimeout> | undefined = undefined;
  private lastConfig: CurrentConfig<Config> | undefined = undefined;
  private readonly onError: (error: Error, rendition: string) => void;

  constructor(onError: (error: Error, rendition: string) => void) {
    this.onError = onError;
  }

  protected abstract start(outputs: EncoderOutputs<Config>): Promise<RunningEncoder>;

  /** Told each time the sinks' wants or limits change. */
  protected changed(): void {
    this.kick();
  }

  /** Attach a sink: its control, and the track it answers with once it has one. */
  consume(open: (control: RenditionControl) => EncodedTrack<Config>): () => void {
    const consumer: Consumer<Config> = { track: undefined, wanted: false, limit: undefined, synced: false };
    this.consumers.add(consumer);
    const control: RenditionControl = {
      want: wanted => {
        // A sink that stops wanting is cut at once, so it never holds half a group; either way the lane re-plans.
        if (consumer.wanted === wanted) return;
        consumer.wanted = wanted;
        if (!wanted && consumer.synced) {
          consumer.synced = false;
          consumer.track?.cut();
        }
        this.changed();
      },
      limit: bitrate => {
        if (consumer.limit === bitrate) return;
        consumer.limit = bitrate;
        this.changed();
      }
    };
    consumer.track = open(control);
    this.changed();
    return () => {
      if (!this.consumers.delete(consumer)) return;
      consumer.track?.close();
      this.changed();
    };
  }

  /** The lowest limit any wanting sink has set. */
  protected ceiling(): number | undefined {
    let lowest: number | undefined = undefined;
    for (const consumer of this.consumers) {
      if (!consumer.wanted || consumer.limit === undefined) continue;
      lowest = lowest === undefined ? consumer.limit : Math.min(lowest, consumer.limit);
    }
    return lowest;
  }

  private isWanted(): boolean {
    // Some sink wants it and has answered with its track; a closed lane wants nothing.
    if (this.isClosed) return false;
    for (const consumer of this.consumers) if (consumer.wanted && consumer.track !== undefined) return true;
    return false;
  }

  /** Make the encoder what is wanted now, then again for as long as what is wanted changes meanwhile. */
  protected kick(): void {
    if (this.busy) {
      this.again = true;
      return;
    }
    this.busy = true;
    void (async () => {
      do {
        this.again = false;
        try {
          await this.reconcile();
        } catch (error) {
          this.fail(error instanceof Error ? error : new Error(String(error)));
        }
      } while (this.again);
      this.busy = false;
    })();
  }

  private async reconcile(): Promise<void> {
    // Stop a running encoder that is no longer wanted or is out of date (cutting its sinks first), then start one
    // if wanted and none runs. Each encoder is a generation: what one says once it is no longer the current one
    // (a packet flushed while it stops, an error) is ignored.
    const wanted = this.isWanted();
    if (this.running !== undefined && (!wanted || this.runningVersion !== this.version)) {
      const running = this.running;
      this.running = undefined;
      this.generation += 1;
      this.cutAll();
      await running.stop();
    }
    if (!wanted || this.running !== undefined) return;
    this.generation += 1;
    const generation = this.generation;
    const current = () => generation === this.generation;
    this.runningVersion = this.version;
    const running = await this.start({
      config: (config, encoding) => {
        if (current()) this.configureAll(config, encoding);
      },
      frame: frame => {
        if (current()) this.writeAll(frame);
      },
      error: error => {
        if (!current()) return;
        this.generation += 1;
        const failed = this.running;
        this.running = undefined;
        this.cutAll();
        void failed?.stop().catch(() => undefined);
        this.fail(error);
      }
    });
    // An encoder that failed while it started is stopped at once rather than kept.
    if (current()) this.running = running;
    else await running.stop().catch(() => undefined);
  }

  /** Report a failure, and try again shortly while the lane is still wanted. */
  private fail(error: Error): void {
    this.onError(error, this.name);
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.kick(), RETRY_MS);
  }

  /** Told each encoder's settings as its first packet comes. */
  protected configured(_encoding: Encoding): void {
    // Nothing by default.
  }

  private configureAll(config: Config, encoding: Encoding): void {
    this.configured(encoding);
    this.lastConfig = { config, encoding };
    for (const consumer of this.consumers) if (consumer.synced) consumer.track?.configure(config, encoding);
  }

  /** Hand a frame to every sink that wants it; one not yet synced starts at a keyframe, configured first. */
  private writeAll(frame: EncodedFrame): void {
    for (const consumer of this.consumers) {
      // Skip a sink that does not want it; one not yet synced waits for a keyframe, and is configured before it.
      if (!consumer.wanted || consumer.track === undefined) continue;
      if (!consumer.synced) {
        if (!frame.keyframe || this.lastConfig === undefined) continue;
        consumer.track.configure(this.lastConfig.config, this.lastConfig.encoding);
        consumer.synced = true;
      }
      consumer.track.write(frame);
    }
  }

  /** Encoding has stopped: every sink written to is told, and resyncs from the next keyframe. */
  private cutAll(): void {
    this.lastConfig = undefined;
    for (const consumer of this.consumers) {
      if (!consumer.synced) continue;
      consumer.synced = false;
      consumer.track?.cut();
    }
  }

  close(): void {
    this.isClosed = true;
    clearTimeout(this.retryTimer);
    // A copy, as each is removed while it is gone through.
    for (const consumer of Array.from(this.consumers)) {
      this.consumers.delete(consumer);
      consumer.track?.close();
    }
    this.kick();
  }
}

/**
 * A video rendition's lane: an encoder of the capture's own track at the rung's size (Mediabunny resizes it), and the
 * governor that says what to encode it at.
 */
class VideoLane extends Lane<VideoDecoderConfig> {
  readonly rendition: ResolvedVideo;
  readonly governor: Governor;
  private readonly source: MediaStreamVideoTrack;

  constructor(source: MediaStreamVideoTrack, rendition: ResolvedVideo, onError: (error: Error, name: string) => void) {
    super(onError);
    this.source = source;
    this.rendition = rendition;
    this.governor = new Governor(rendition, () => {
      this.version += 1;
      this.kick();
    });
  }

  get name(): string {
    return this.rendition.name;
  }

  protected override changed(): void {
    this.governor.ceiling(this.ceiling());
    super.changed();
  }

  /** The bitrate the quality comes to at the rung's full size is what the governor weighs a ceiling against. */
  protected override configured(encoding: Encoding): void {
    const { bitrate, scale } = this.governor.target;
    if (bitrate === undefined && scale === 1 && encoding.bitrate > 0) this.governor.known(encoding.bitrate);
  }

  /**
   * Each encoder reads a clone of the capture's track of its own, stopped with it: a new MediaStreamTrackProcessor on
   * a track whose last one is still closing may never be given a frame (the broadcast lab, 2026-11-26: a rung
   * restarted on the shared track stayed silent), and Mediabunny reads a clone itself where it reads in a worker.
   */
  protected async start(outputs: EncoderOutputs<VideoDecoderConfig>): Promise<RunningEncoder> {
    const track = this.source.clone();
    try {
      const running = await startVideoEncoder(
        track,
        { rendition: this.rendition, target: this.governor.target },
        outputs
      );
      return {
        stop: async () => {
          await running.stop();
          track.stop();
        }
      };
    } catch (error) {
      track.stop();
      throw error;
    }
  }

  override close(): void {
    super.close();
    this.governor.close();
  }
}

/** The sound's lane: one encoder, at the resolved bitrate. */
class AudioLane extends Lane<AudioDecoderConfig> {
  readonly rendition: ResolvedAudio;
  private readonly track: MediaStreamAudioTrack;

  constructor(source: MediaStreamAudioTrack, rendition: ResolvedAudio, onError: (error: Error, name: string) => void) {
    super(onError);
    this.rendition = rendition;
    this.track = source;
  }

  get name(): string {
    return this.rendition.name;
  }

  protected start(outputs: EncoderOutputs<AudioDecoderConfig>): Promise<RunningEncoder> {
    return startAudioEncoder(this.track, this.rendition, outputs);
  }
}

/**
 * A capture sent as a resolved broadcast to whichever sinks are connected. The capture itself is left as it is: the
 * pipeline only reads its tracks (Mediabunny stops none it did not make).
 */
export class BroadcastPipeline {
  readonly broadcast: ResolvedBroadcast;
  private readonly videoLanes: VideoLane[];
  private readonly audioLane: AudioLane | undefined;
  private readonly stopPressure: () => void;
  private readonly disconnects = new Set<() => void>();

  constructor(media: MediaStream, broadcast: ResolvedBroadcast, options: PipelineOptions = {}) {
    // A lane per rendition the capture has a track for, and the CPU's pressure watched unless adapting is off.
    this.broadcast = broadcast;
    const onError = options.onError ?? ((error, name) => console.warn(`broadcast ${name}:`, error));
    const [videoTrack] = media.getVideoTracks();
    const [audioTrack] = media.getAudioTracks();
    this.videoLanes =
      videoTrack === undefined ? [] : broadcast.video.map(rendition => new VideoLane(videoTrack, rendition, onError));
    this.audioLane =
      audioTrack === undefined || broadcast.audio === undefined
        ? undefined
        : new AudioLane(audioTrack, broadcast.audio, onError);
    this.stopPressure =
      options.adapt === false
        ? () => undefined
        : watchPressure(state => {
            for (const lane of this.videoLanes) lane.governor.pressure(state);
          });
  }

  /** Send to a sink until the returned function is called. */
  connect(sink: BroadcastSink): () => void {
    const releases = this.videoLanes.map(lane => lane.consume(control => sink.video(lane.rendition, control)));
    const audio = this.audioLane;
    if (audio !== undefined) releases.push(audio.consume(control => sink.audio(audio.rendition, control)));
    const disconnect = () => {
      if (!this.disconnects.delete(disconnect)) return;
      for (const release of releases) release();
    };
    this.disconnects.add(disconnect);
    return disconnect;
  }

  /** Disconnect every sink, stop encoding, and let go of the tracks the pipeline made. */
  close(): void {
    // A copy, as each disconnect removes itself while they are gone through.
    for (const disconnect of Array.from(this.disconnects)) disconnect();
    this.stopPressure();
    for (const lane of this.videoLanes) lane.close();
    this.audioLane?.close();
  }
}
