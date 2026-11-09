import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { AlwaysAvailableTrack } from '@conservationtv/mediamtx';
import type { CtvStream } from '@conservationtv/shows/ctv-stream';
import { AttachedProcess } from '@conservationtv/converge/process';
import type { Client } from '@conservationtv/studio-sdk';
import { getLogger } from '@logtape/logtape';
import type { ObsHandle, ObsInput, ObsSourcePlugin } from '@strangecyan/vignette/obs';
import { z } from 'zod';
import type { ProgramMediamtx } from './program.ts';

// The `ctv-stream` source kind (packages/shows) in OBS. A stream is read over MoQ as the agent's device, which the
// studio API admits for what its show places (apps/studio/api/src/gateways/connect.ts), and pushed by a `moq` CLI into
// the program MediaMTX (program.ts), where a stock media source plays it:
//
//   moq --connect <relay?jwt=…> --broadcast <name> export rtmp --connect rtmp://127.0.0.1:<port>/cams/<source>
//
// Going through MediaMTX logs every push and read, and lets each camera fall back to MediaMTX's offline segment while
// its relay is down, so OBS's input never sees the stream end. Falling back needs the stream's exact tracks, which are
// read from its catalog (`moq … fetch catalog.json`) before the push starts; without them the path has no fallback.
//
// The session (a relay URL carrying a short-lived token) is the agent's own, asked for when the source is placed and
// again before it expires. A new one restarts `moq`, pushing to the same path, so the OBS input never changes. Each
// `moq` is the agent's child (converge's AttachedProcess), restarted if it dies.

const logger = getLogger(['agent', 'obs', 'ctv-stream']);
const run = promisify(execFile);

/** How long reading a stream's catalog may take before the push starts without a fallback. */
const CATALOG_TIMEOUT_MS = 10_000;

/** How long before a session expires to ask for the next, and the soonest to ask again after a failure. */
const RENEW_BEFORE_MS = 10 * 60_000;
const RETRY_MS = 60_000;

/**
 * How stale a group may get before `moq` skips it: RTMP is unpaced, so this bounds what `moq` buffers. Low, as
 * MediaMTX is on the same machine and the stream is live: skipping beats falling behind.
 */
const MAX_AGE = '100ms';

/**
 * FFmpeg's options for opening the relay, as OBS passes them on (`ffmpeg_options`): ask the relay to buffer as little
 * as it can (`rtmp_buffer`, in milliseconds), and decide the streams from the first packets rather than probing for
 * seconds. Checked against `moq export rtmp`: H.264 and AAC are still both found. With `buffering_mb` 0, OBS also opens
 * it with FFmpeg's `nobuffer` flag and keeps no network buffer of its own.
 */
const FFMPEG_OPTIONS = 'rtmp_buffer=100 probesize=32768 analyzeduration=0';

type CtvStreamSource = Parameters<NonNullable<ObsSourcePlugin<typeof CtvStream>['create']>>[0];
type CtvStreamProps = CtvStreamSource['props'];

/**
 * What the plugin needs from the runtime: the studio API, as the device, the `moq` to run, the program MediaMTX to push
 * into, and where relays live.
 */
export interface CtvStreamObsOptions {
  studio: Client;
  /** The installed `moq` CLI. */
  moq: string;
  program: ProgramMediamtx;
  /** A folder of the plugin's own, for each relay's log and pidfile. */
  directory: string;
}

/** Plays `ctv-stream` sources in vignette's OBS target. */
export function ctvStreamObs(options: CtvStreamObsOptions): ObsSourcePlugin<typeof CtvStream> {
  return {
    kind: 'ctv-stream',
    async create(source, context) {
      const relay = new Relay(options, source.id);
      context.signal.addEventListener('abort', () => void relay.stop(), { once: true });
      try {
        await relay.follow(source.props);
      } catch (error) {
        // Vignette tries the source again with a relay of its own: this one must not linger, pushing to the same path.
        await relay.stop();
        throw error;
      }
      const input = relayInput(options.program.cameraUrl(source.id));
      return {
        input,
        update: next => relay.follow(next.props),
        dispose: () => relay.stop()
      } satisfies ObsHandle<typeof CtvStream>;
    }
  };
}

/**
 * A media source playing the camera's path with as little delay as it can: no buffering of its own, FFmpeg asked for
 * none either, decoded in hardware where it can be. It reconnects quickly if MediaMTX restarts.
 */
function relayInput(url: string): ObsInput {
  return {
    kind: 'ffmpeg_source',
    settings: {
      input: url,
      is_local_file: false,
      buffering_mb: 0,
      ffmpeg_options: FFMPEG_OPTIONS,
      hw_decode: true,
      reconnect_delay_sec: 1,
      restart_on_activate: false,
      close_when_inactive: false
    },
    // Muted, as the studio's preview is, until a show says how its sound is mixed.
    muted: true
  };
}

/** Where to read an exposure: the relay URL, carrying its token as `?jwt=`, the broadcast, and when it expires. */
interface Session {
  url: string;
  broadcast: string;
  expiresAt: number;
}

/** A read session for the exposure, as the device. Throws if the API refuses it, or offers anything but MoQ. */
async function readSession(studio: Client, props: CtvStreamProps): Promise<Session> {
  const connection = await studio.organisations.streams.exposures.connect.v1({
    id: props.organisationId,
    streamId: props.streamId,
    exposureId: props.exposureId,
    action: 'read',
    protocol: 'moq'
  });
  if (connection instanceof Error) throw connection;
  if (!('relay' in connection)) throw new Error(`Exposure ${props.exposureId} is not read by MoQ`);
  const url = new URL(connection.path, connection.relay);
  if (connection.token !== undefined) url.searchParams.set('jwt', connection.token);
  const expiresAt = connection.expiresAt === undefined ? Infinity : Date.parse(connection.expiresAt);
  return { url: url.href, broadcast: connection.broadcast, expiresAt };
}

/** The parts of a hang catalog that say what each track carries. */
const CatalogTracksSchema = z.object({
  video: z.object({ renditions: z.record(z.string(), z.object({ codec: z.string() })) }).optional(),
  audio: z
    .object({
      renditions: z.record(
        z.string(),
        z.object({ codec: z.string(), sampleRate: z.number(), numberOfChannels: z.number() })
      )
    })
    .optional()
});
export type CatalogTracks = z.output<typeof CatalogTracksSchema>;

/** MediaMTX's codec for a WebCodecs video codec string, by its prefix. */
const VIDEO_CODECS = new Map<string, AlwaysAvailableTrack['codec']>([
  ['avc1', 'H264'],
  ['avc3', 'H264'],
  ['hev1', 'H265'],
  ['hvc1', 'H265'],
  ['av01', 'AV1'],
  ['vp09', 'VP9']
]);

type CatalogAudio = NonNullable<CatalogTracks['audio']>['renditions'][string];

/** MediaMTX's track for a WebCodecs audio rendition: AAC (`mp4a.…`) or Opus; undefined for any other. */
function audioTrack(audio: CatalogAudio): AlwaysAvailableTrack | undefined {
  const channelCount = audio.numberOfChannels;
  if (audio.codec.startsWith('mp4a')) return { codec: 'MPEG4Audio', sampleRate: audio.sampleRate, channelCount };
  if (audio.codec === 'opus') return { codec: 'Opus', channelCount };
  return undefined;
}

/**
 * The tracks MediaMTX's fallback must offer to match the stream exactly: its first video rendition and its first audio
 * one, as `moq export rtmp` pushes them. Null if a codec is one MediaMTX can't fall back with.
 */
export function catalogTracks(catalog: CatalogTracks): AlwaysAvailableTrack[] | null {
  const video = firstRendition(catalog.video);
  const audio = firstRendition(catalog.audio);
  const tracks: AlwaysAvailableTrack[] = [];
  // Each section present must map to a track MediaMTX can offer; a stream with neither has nothing to fall back with.
  if (video !== undefined) {
    const track = videoCodecTrack(video.codec);
    if (track === undefined) return null;
    tracks.push(track);
  }
  if (audio !== undefined) {
    const track = audioTrack(audio);
    if (track === undefined) return null;
    tracks.push(track);
  }
  return tracks.length === 0 ? null : tracks;
}

/** A catalog section: its renditions, by track name. */
interface CatalogSection<T> {
  renditions: Record<string, T>;
}

/** A catalog section's first rendition, if it has one. */
function firstRendition<T>(section: CatalogSection<T> | undefined): T | undefined {
  if (section === undefined) return undefined;
  return Object.values(section.renditions)[0];
}

/** MediaMTX's track for a WebCodecs video codec string; undefined for one it doesn't take. */
function videoCodecTrack(codec: string): AlwaysAvailableTrack | undefined {
  const known = VIDEO_CODECS.get(codec.split('.')[0] ?? '');
  return known === undefined ? undefined : { codec: known };
}

/** The session's broadcast's tracks, from its catalog; null if it can't be read in time, or names none MediaMTX takes. */
async function readTracks(moq: string, session: Session): Promise<AlwaysAvailableTrack[] | null> {
  try {
    const args = ['--connect', session.url, '--broadcast', session.broadcast, 'fetch', 'catalog.json'];
    const { stdout } = await run(moq, args, { timeout: CATALOG_TIMEOUT_MS, env: { ...process.env, NO_COLOR: '1' } });
    return catalogTracks(CatalogTracksSchema.parse(JSON.parse(stdout)));
  } catch (error) {
    logger.warn('No fallback for {broadcast}: its catalog could not be read: {error}', {
      broadcast: session.broadcast,
      error
    });
    return null;
  }
}

/**
 * One source's relay: `moq` pushing the exposure's broadcast into the source's path of the program MediaMTX, from the
 * latest session, which it renews before it expires.
 */
class Relay {
  private readonly process: AttachedProcess;
  private props: CtvStreamProps | undefined = undefined;
  private session: Session | undefined = undefined;
  private renewal: ReturnType<typeof setTimeout> | undefined = undefined;
  private readonly stopping = new AbortController();

  constructor(
    private readonly options: CtvStreamObsOptions,
    private readonly sourceId: string
  ) {
    // Ready once MediaMTX has the push: before it starts, nothing publishes there, so nothing else is taken for it.
    this.process = new AttachedProcess(join(options.directory, sourceId), {
      name: 'moq',
      probe: signal => options.program.publishing(sourceId, signal),
      readyTimeoutMs: 30_000
    });
  }

  /** Serve the exposure `props` name: with a new session if it is another exposure, as it is the first time. */
  async follow(props: CtvStreamProps): Promise<void> {
    const same = this.props?.exposureId === props.exposureId && this.props.streamId === props.streamId;
    this.props = props;
    if (same && this.session !== undefined) return;
    await this.renew();
  }

  /**
   * Ask for a session and restart `moq` with it, then schedule the next. A failure once serving is tried again a minute
   * on; the first is thrown, for vignette to retry the source, without a retry of this relay's own.
   */
  private async renew(): Promise<void> {
    clearTimeout(this.renewal);
    const props = this.props;
    if (props === undefined || this.stopping.signal.aborted) return;
    try {
      const session = await readSession(this.options.studio, props);
      await this.run(session);
      this.session = session;
      this.schedule(Math.max(session.expiresAt - Date.now() - RENEW_BEFORE_MS, RETRY_MS));
    } catch (error) {
      logger.error('The stream for {sourceId} is unavailable: {error}', { sourceId: this.sourceId, error });
      if (this.session === undefined) throw error;
      this.schedule(RETRY_MS);
    }
  }

  private schedule(delay: number): void {
    if (!Number.isFinite(delay)) return;
    this.renewal = setTimeout(() => void this.renew().catch(() => undefined), delay);
  }

  /**
   * `moq` pushing `session`: the same process while the session is the same, a new one to the same path when not. A
   * new broadcast's tracks are read first, for its path's fallback.
   */
  private async run(session: Session): Promise<void> {
    const { program, moq } = this.options;
    if (session.broadcast !== this.session?.broadcast) {
      const tracks = await readTracks(moq, session);
      await program.setCamera(this.sourceId, tracks);
    }
    const args = [
      ['--connect', session.url, '--broadcast', session.broadcast, 'export'],
      ['rtmp', '--connect', program.cameraUrl(this.sourceId), '--max-age', MAX_AGE]
    ].flat();
    await this.process.ensure(
      { key: session.url, binary: this.options.moq, args, env: { NO_COLOR: '1' } },
      this.stopping.signal
    );
  }

  async stop(): Promise<void> {
    clearTimeout(this.renewal);
    this.stopping.abort();
    await this.process.stop();
    await this.options.program.removeCamera(this.sourceId);
  }
}
