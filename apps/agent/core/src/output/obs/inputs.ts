import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { AttachedProcess } from '@conservationtv/converge/process';
import type { AlwaysAvailableTrack } from '@conservationtv/mediamtx';
import type { Client } from '@conservationtv/studio-sdk';
import { getLogger } from '@logtape/logtape';
import { BehaviorSubject } from 'rxjs';
import { z } from 'zod';
import { expiryOf, withToken } from '../../studio.ts';
import { type InputExposure, inputOf, inputPath, type ProgramMediamtx } from './program.ts';

// The exposures OBS plays, whoever drives its scenes: the show (output/show/ctv-stream.ts), or something outside the
// studio. OBS reads any of its organisation's exposures from the program MediaMTX, at `inputs/<stream>/<exposure>`
// (program.ts), and the agent relays it there for as long as something reads it:
//
//   OBS reads inputs/<s>/<e>  ─▶  MediaMTX runs the demand launcher (`runOnDemand`, then `runOnRead`)
//                                    │ holds a request to the agent's demand server open while it runs
//                                    ▼
//   a relay per exposure:  moq --connect <relay?jwt=…> --broadcast <name> export rtmp --connect rtmp://…/inputs/<s>/<e>
//
// The launcher is a small Node script the agent writes, run by the agent's own Node, whose one request says which path
// is wanted (MediaMTX gives it `MTX_PATH`) and, by staying open, for how long: MediaMTX stops it once nothing reads the
// path. The first time an exposure is wanted, the agent asks for a read session as its device (the studio API admits
// what the output may play: src/gateways/connect.ts), reads the stream's tracks from its catalog, and gives the path
// its own config, always available with those tracks and telling the agent of each reader (`runOnRead`): so while the
// relay restarts for a new session, OBS plays MediaMTX's offline segment rather than losing the stream. A relay is
// stopped, and its path's config dropped, once nothing has read it for `RELEASE_AFTER_MS`, long enough for OBS to
// reconnect after its path's config is first written (which drops the reader waiting on it).
//
// The session is renewed before it expires, restarting `moq` to the same path, so OBS's input never changes. Each
// `moq` is the agent's child (converge's AttachedProcess), restarted if it dies.

const logger = getLogger(['agent', 'obs', 'inputs']);
const run = promisify(execFile);

/** How long an exposure is relayed after the last reader goes. */
const RELEASE_AFTER_MS = 30_000;

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

/** The launcher MediaMTX runs for a wanted path: one request to the demand server, held open until it is stopped. */
const LAUNCHER = `import { request } from 'node:http';
// Written by the conservation.tv agent (output/obs/inputs.ts): tells it, for as long as this runs, that MediaMTX's
// path MTX_PATH is wanted.
const [port, secret] = process.argv.slice(2);
const path = process.env.MTX_PATH ?? '';
const held = request({ host: '127.0.0.1', port: Number(port), path: '/' + secret + '/' + path }, response => {
  response.resume();
  response.on('end', () => process.exit(0));
});
held.on('error', () => process.exit(1));
held.end();
const stop = () => {
  held.destroy();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
`;

/** What the relays need: the studio API, as the device, the program MediaMTX, and a folder of their own. */
export interface InputRelaysOptions {
  studio: Client;
  program: ProgramMediamtx;
  directory: string;
}

/** What is relayed: for each exposure's path, how many read it now. */
export interface InputsStatus {
  reading: Record<string, number>;
}

/** Where to read an exposure: the relay URL, carrying its token as `?jwt=`, the broadcast, and when it expires. */
interface Session {
  url: string;
  broadcast: string;
  expiresAt: number;
}

/** One exposure being relayed: the relay, how many read it, and when it is let go of when none does. */
interface Wanted {
  relay: Relay;
  readers: number;
  release: ReturnType<typeof setTimeout> | undefined;
}

/**
 * The exposures OBS plays, relayed into the program MediaMTX while they are read, for the organisation `serve` names.
 * Its demand server listens on loopback from `serve` until `dispose`.
 */
export class InputRelays {
  readonly status$ = new BehaviorSubject<InputsStatus>({ reading: {} });
  private readonly secret = randomBytes(18).toString('base64url');
  private readonly wanted = new Map<string, Wanted>();
  private server: Server | undefined = undefined;
  private moq: string | undefined = undefined;
  private organisationId: string | undefined = undefined;

  constructor(private readonly options: InputRelaysOptions) {}

  /**
   * Relay the organisation's exposures, by the `moq` CLI at `moq`: the demand server listening, the launcher written,
   * and the program MediaMTX told to run it.
   */
  async serve(organisationId: string, moq: string): Promise<void> {
    if (this.organisationId !== undefined && this.organisationId !== organisationId) this.releaseAll();
    this.organisationId = organisationId;
    this.moq = moq;
    const port = await this.listen();
    const launcher = join(this.options.directory, 'demand.mjs');
    await mkdir(this.options.directory, { recursive: true });
    await writeFile(launcher, LAUNCHER);
    await this.options.program.setDemand(demandCommand(process.execPath, launcher, port, this.secret));
  }

  /** Where OBS reads the exposure, at the program MediaMTX. */
  url(exposure: InputExposure): string {
    return this.options.program.pathUrl(inputPath(exposure));
  }

  /** Stop relaying anything, and stop listening. */
  async stop(): Promise<void> {
    this.releaseAll();
    await this.options.program.setDemand(undefined);
    await new Promise<void>(resolve => {
      if (this.server === undefined) resolve();
      else this.server.close(() => resolve());
    });
    this.server = undefined;
  }

  dispose(): void {
    this.releaseAll();
    this.server?.close();
    this.server = undefined;
  }

  /** The demand server, on a port of the system's choosing on loopback: started once. */
  private async listen(): Promise<number> {
    if (this.server === undefined) {
      const server = createServer((request, response) => this.demanded(request, response));
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve());
      });
      this.server = server;
    }
    // SAFETY: a server listening on TCP has an address of its own.
    return (this.server.address() as AddressInfo).port;
  }

  /** A launcher's request: the path it names is wanted until the request closes. Anything else is refused. */
  private demanded(request: IncomingMessage, response: ServerResponse): void {
    const prefix = `/${this.secret}/`;
    const path = request.url?.startsWith(prefix) ? request.url.slice(prefix.length) : undefined;
    const exposure = path === undefined ? undefined : inputOf(path);
    if (path === undefined || exposure === undefined) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200);
    response.flushHeaders();
    this.acquire(path, exposure);
    request.socket.once('close', () => this.release(path));
  }

  /** One more reader of the exposure: its relay started if it isn't running. */
  private acquire(path: string, exposure: InputExposure): void {
    const { moq, organisationId } = this;
    if (moq === undefined || organisationId === undefined) return;
    let wanted = this.wanted.get(path);
    if (wanted === undefined) {
      const relay = new Relay(this.options, moq, path, { organisationId, ...exposure });
      wanted = { relay, readers: 0, release: undefined };
      this.wanted.set(path, wanted);
      // One that cannot start is let go of now, for the next reader to try afresh.
      relay.start().catch(() => {
        if (this.wanted.get(path)?.relay === relay) this.drop(path);
      });
    }
    clearTimeout(wanted.release);
    wanted.release = undefined;
    wanted.readers += 1;
    this.report();
  }

  /** One reader fewer: with none, the relay is stopped once none has come back for a while. */
  private release(path: string): void {
    const wanted = this.wanted.get(path);
    if (wanted === undefined) return;
    wanted.readers = Math.max(wanted.readers - 1, 0);
    if (wanted.readers === 0) wanted.release = setTimeout(() => this.drop(path), RELEASE_AFTER_MS);
    this.report();
  }

  private drop(path: string): void {
    const wanted = this.wanted.get(path);
    if (wanted === undefined) return;
    clearTimeout(wanted.release);
    this.wanted.delete(path);
    void wanted.relay.stop();
    this.report();
  }

  private releaseAll(): void {
    for (const path of this.wanted.keys()) this.drop(path);
  }

  private report(): void {
    const reading = Object.fromEntries([...this.wanted].map(([path, wanted]) => [path, wanted.readers]));
    this.status$.next({ reading });
  }
}

/**
 * The command MediaMTX runs for a wanted path: Node running the launcher, which asks the demand server on `port`. Each
 * argument single-quoted, as MediaMTX splits a command as a POSIX shell would, on every platform.
 */
export function demandCommand(node: string, launcher: string, port: number, secret: string): string {
  return [node, launcher, String(port), secret].map(quoted).join(' ');
}

function quoted(argument: string): string {
  if (argument.includes("'")) throw new Error(`Cannot quote ${argument} for MediaMTX`);
  return `'${argument}'`;
}

/** An exposure, as its read session is asked for. */
interface RelayedExposure extends InputExposure {
  organisationId: string;
}

/**
 * One exposure's relay: `moq` pushing its broadcast into its path of the program MediaMTX, from the latest session,
 * which it renews before it expires.
 */
class Relay {
  private readonly process: AttachedProcess;
  private session: Session | undefined = undefined;
  private renewal: ReturnType<typeof setTimeout> | undefined = undefined;
  private readonly stopping = new AbortController();

  constructor(
    private readonly options: InputRelaysOptions,
    private readonly moq: string,
    private readonly path: string,
    private readonly exposure: RelayedExposure
  ) {
    // Ready once MediaMTX has the push: before it starts, nothing publishes there, so nothing else is taken for it.
    this.process = new AttachedProcess(join(options.directory, exposure.exposureId), {
      name: 'moq',
      probe: signal => options.program.publishing(path, signal),
      readyTimeoutMs: 30_000
    });
  }

  /** Relay the exposure: throws if its first session can't be had, or `moq` won't start. */
  start(): Promise<void> {
    return this.renew();
  }

  /**
   * Ask for a session and restart `moq` with it, then schedule the next. A failure once relaying is tried again a
   * minute on; the first is thrown.
   */
  private async renew(): Promise<void> {
    clearTimeout(this.renewal);
    if (this.stopping.signal.aborted) return;
    try {
      const session = await readSession(this.options.studio, this.exposure);
      await this.run(session);
      this.session = session;
      this.schedule(Math.max(session.expiresAt - Date.now() - RENEW_BEFORE_MS, RETRY_MS));
    } catch (error) {
      if (this.stopping.signal.aborted) return;
      logger.error('Exposure {exposureId} cannot be relayed: {error}', { exposureId: this.exposure.exposureId, error });
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
    const { program } = this.options;
    if (session.broadcast !== this.session?.broadcast) {
      const tracks = await readTracks(this.moq, session);
      await program.setInput(this.path, tracks);
    }
    const args = [
      ['--connect', session.url, '--broadcast', session.broadcast, 'export'],
      ['rtmp', '--connect', program.pathUrl(this.path), '--max-age', MAX_AGE]
    ].flat();
    await this.process.ensure(
      { key: session.url, binary: this.moq, args, env: { NO_COLOR: '1' } },
      this.stopping.signal
    );
  }

  async stop(): Promise<void> {
    clearTimeout(this.renewal);
    this.stopping.abort();
    await this.process.stop();
    await this.options.program.removeInput(this.path);
  }
}

/** A read session for the exposure, as the device. Throws if the API refuses it, or offers anything but MoQ. */
async function readSession(studio: Client, exposure: RelayedExposure): Promise<Session> {
  const connection = await studio.organisations.streams.exposures.connect.v1({
    id: exposure.organisationId,
    streamId: exposure.streamId,
    exposureId: exposure.exposureId,
    action: 'read',
    protocol: 'moq'
  });
  if (connection instanceof Error) throw connection;
  if (!('relay' in connection)) throw new Error(`Exposure ${exposure.exposureId} is not read by MoQ`);
  const url = new URL(connection.path, connection.relay);
  return { url: withToken(url, connection.token), broadcast: connection.broadcast, expiresAt: expiryOf(connection) };
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
