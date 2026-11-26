import * as Publish from '@moq/publish';
import type { Net } from '@moq/publish';

import { avccToAnnexB, parseAvcC, type AvcParameters } from '../bitstream.ts';
import type { ResolvedAudio, ResolvedVideo } from '../resolve.ts';
import type { EncodedSink, EncodedTrack, Encoding, RenditionControl } from '../sink.ts';

// A MoQ broadcast as an encoded sink: each rendition a track on a `@moq/publish` Broadcast, in the catalog while
// its config is known, wanted while a subscriber is attached (the relay's demand), and limited to its share of the
// connection's estimated send rate. Frames go out in hang's legacy container, H.264 rewritten as Annex B with its
// parameter sets in-band, as `@moq/publish`'s own encoder sends it, so readers see no difference but the picture.
//
// The broadcast and its connection stay the caller's: closing the sink unregisters its renditions only.

export interface MoqSinkOptions {
  /** The connection's bandwidth allocator (`Net.Connection.bandwidth`): each rendition is limited to its share. */
  bandwidth?: Publish.Signals.Getter<Net.Bandwidth.Handle | undefined>;
}

/** hang's own idea of a track producer: the same class, from its own copy of `@moq/net`. */
type HangTrack = ConstructorParameters<typeof Publish.Hang.Container.Legacy.Producer>[0];

/**
 * A broadcast's track as hang's container takes it. `@moq/hang` resolves its own copy of `@moq/net` (another `zod`
 * peer), whose classes are the same but, with private fields, not the same type; `@moq/publish` hands one to the
 * other the same way at runtime.
 */
function asHangTrack(track: Net.Track.Producer): HangTrack {
  // SAFETY: the same class from two installs of the same version of @moq/net; only its type identity differs, and
  // the two declarations share no type to narrow through.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- two copies of one class, as above.
  return track as unknown as HangTrack;
}

/** A video rendition's catalog entry. */
type VideoEntry = Publish.Hang.Catalog.VideoConfig;

/** The sound's catalog entry. */
type AudioEntry = Publish.Hang.Catalog.AudioConfig;

/**
 * Each codec's usual string, for a rendition's catalog entry before its encoder has said exactly which it encodes:
 * readers choose and subscribe by the entry, and the encoder starts only once one does. The exact entry replaces it
 * with the first decoder config, which readers follow.
 */
const PROVISIONAL_CODEC = {
  avc: 'avc1.640028',
  hevc: 'hev1.1.6.L120.B0',
  vp9: 'vp09.00.40.08',
  av1: 'av01.0.08M.08',
  vp8: 'vp8'
} satisfies Record<ResolvedVideo['codec'], string>;

/**
 * A video rendition's entry from its resolved settings alone: its bitrate is the encoder's to say (Mediabunny's, from
 * the quality and the size), so it is left out until then.
 */
function provisionalVideo(resolved: ResolvedVideo): VideoEntry {
  const u53 = Publish.Hang.Catalog.u53;
  return {
    codec: PROVISIONAL_CODEC[resolved.codec],
    container: { kind: 'legacy' },
    codedWidth: u53(resolved.width),
    codedHeight: u53(resolved.height),
    framerate: resolved.frameRate,
    optimizeForLatency: true
  };
}

/** The sound's entry from its resolved settings alone. */
function provisionalAudio(resolved: ResolvedAudio): AudioEntry {
  const u53 = Publish.Hang.Catalog.u53;
  return {
    codec: resolved.codec === 'opus' ? 'opus' : 'mp4a.40.2',
    container: { kind: 'legacy' },
    sampleRate: u53(resolved.sampleRate),
    numberOfChannels: u53(resolved.channels),
    bitrate: u53(resolved.bitrate)
  };
}

/** Bytes as the catalog's hex. */
function hex(source: AllowSharedBufferSource): string {
  const bytes = ArrayBuffer.isView(source)
    ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
    : new Uint8Array(source);
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

/**
 * A rendition's track, wanted while subscribed, limited to its share of the connection. The share is reserved once
 * the most it can send is known (`max`, set from its encoder's config), and grows with it, never shrinking: a
 * rendition held to a lower bitrate for want of bandwidth still claims what it would send if it could.
 */
function follow(
  rendition: Publish.Rendition<unknown>,
  max: Publish.Signals.Getter<number | undefined>,
  control: RenditionControl,
  options: MoqSinkOptions,
  open: (track: Net.Track.Producer | undefined) => void
): Publish.Signals.Effect {
  const effect = new Publish.Signals.Effect();
  effect.run(inner => {
    const track = inner.get(rendition.track);
    open(track);
    control.want(track !== undefined);
  });
  effect.run(inner => {
    const track = inner.get(rendition.track);
    const handle = options.bandwidth === undefined ? undefined : inner.get(options.bandwidth);
    const most = inner.get(max);
    if (track === undefined || handle === undefined || most === undefined) return;
    // The reservation is the most the rendition can send, not what it sends now: its share is the limit.
    const reservation = handle.reserve(track, most);
    inner.cleanup(() => {
      reservation.close();
      control.limit(undefined);
    });
    inner.run(granted => control.limit(granted.get(reservation.grant)));
  });
  return effect;
}

/** Raise the most a rendition can send to `bitrate` (from its encoder's config), never lowering it. */
function reserveUpTo(most: Publish.Signals.Signal<number | undefined>, bitrate: number): void {
  const before = most.peek();
  if (bitrate > 0 && (before === undefined || bitrate > before)) most.set(bitrate);
}

/** The video side: catalog entry from each decoder config, frames into a legacy producer per subscription. */
function videoTrack(
  broadcast: Publish.Broadcast,
  resolved: ResolvedVideo,
  control: RenditionControl,
  options: MoqSinkOptions
): EncodedTrack<VideoDecoderConfig> {
  const rendition = broadcast.video(resolved.name);
  // Listed before anything is encoded, or no subscriber would ever ask for it: encoding waits for one.
  rendition.config.set(provisionalVideo(resolved));
  const Legacy = Publish.Hang.Container.Legacy;
  let producer: InstanceType<typeof Legacy.Producer> | undefined = undefined;
  // A producer must start at a keyframe; one opened mid-stream waits for the next.
  let started = false;
  let avc: AvcParameters | undefined = undefined;
  const most = new Publish.Signals.Signal<number | undefined>(undefined);
  const effect = follow(rendition, most, control, options, track => {
    // A new subscription gets its own producer, waiting for a keyframe; the last one, gone, is cut.
    const previous = producer;
    producer = track === undefined ? undefined : new Legacy.Producer(asHangTrack(track), new Legacy.Format('video'));
    started = false;
    if (previous !== undefined && track === undefined) {
      try {
        previous.cut();
      } catch {
        // The track has already closed.
      }
    }
  });
  return {
    configure: (config: VideoDecoderConfig, encoding: Encoding) => {
      const description = config.description;
      const isAvc = config.codec.startsWith('avc1') || config.codec.startsWith('avc3');
      avc = isAvc && description !== undefined ? parseAvcC(description) : undefined;
      const u53 = Publish.Hang.Catalog.u53;
      const entry: VideoEntry = {
        codec: config.codec,
        container: { kind: 'legacy' },
        codedWidth: u53(config.codedWidth ?? encoding.width),
        codedHeight: u53(config.codedHeight ?? encoding.height),
        framerate: encoding.frameRate,
        bitrate: u53(encoding.bitrate),
        optimizeForLatency: true
      };
      // Annex B carries its parameter sets in-band; anything else is described as its encoder described it.
      if (avc === undefined && description !== undefined) entry.description = hex(description);
      rendition.config.set(entry);
      reserveUpTo(most, encoding.bitrate);
    },
    write: frame => {
      // Nothing is written before a keyframe, and a frame the producer refuses waits for the next one.
      if (producer === undefined) return;
      if (!started && !frame.keyframe) return;
      started = true;
      const data = avc === undefined ? frame.data : avccToAnnexB(frame.data, avc, frame.keyframe);
      try {
        producer.encode(data, Publish.Net.Time.Micro(frame.timestamp), frame.keyframe);
      } catch {
        // A frame behind the live edge (encoding restarted on a clock that went back), or a closed track: the next
        // keyframe starts afresh.
        started = false;
      }
    },
    cut: () => {
      started = false;
      try {
        producer?.cut();
      } catch {
        // The track has already closed.
      }
    },
    close: () => {
      effect.close();
      rendition.close();
    }
  };
}

/** The audio side: every frame its own group, as `@moq/publish` sends sound. */
function audioTrack(
  broadcast: Publish.Broadcast,
  resolved: ResolvedAudio,
  control: RenditionControl,
  options: MoqSinkOptions
): EncodedTrack<AudioDecoderConfig> {
  const rendition = broadcast.audio(resolved.name);
  rendition.config.set(provisionalAudio(resolved));
  let track: Net.Track.Producer | undefined = undefined;
  const most = new Publish.Signals.Signal<number | undefined>(resolved.bitrate);
  const effect = follow(rendition, most, control, options, next => {
    track = next;
  });
  return {
    configure: config => {
      const u53 = Publish.Hang.Catalog.u53;
      const entry: AudioEntry = {
        codec: config.codec,
        container: { kind: 'legacy' },
        sampleRate: u53(config.sampleRate),
        numberOfChannels: u53(config.numberOfChannels),
        bitrate: u53(resolved.bitrate)
      };
      if (config.description !== undefined) entry.description = hex(config.description);
      rendition.config.set(entry);
    },
    write: frame => {
      if (track === undefined || track.closed.peek() !== undefined) return;
      const timestamp = Publish.Net.Time.Micro(frame.timestamp);
      track.writeFrame({
        payload: Publish.Hang.Container.Legacy.encodeFrame(frame.data, timestamp),
        timestamp: Publish.Net.Time.Timestamp.fromMicros(frame.timestamp)
      });
    },
    cut: () => undefined,
    close: () => {
      effect.close();
      rendition.close();
    }
  };
}

/** Send a pipeline's renditions as tracks of a MoQ broadcast. */
export function moqSink(broadcast: Publish.Broadcast, options: MoqSinkOptions = {}): EncodedSink {
  return {
    kind: 'encoded',
    video: (rendition, control) => videoTrack(broadcast, rendition, control, options),
    audio: (rendition, control) => audioTrack(broadcast, rendition, control, options)
  };
}
