import { connect as dial } from 'node:net';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AttachedProcess, type ProcessStatus, STOPPED as PROCESS_STOPPED } from '@conservationtv/converge/process';
import { type AlwaysAvailableTrack, type MediamtxConfig, toYaml } from '@conservationtv/mediamtx';
import { forwardSubject, previewSubject } from '@conservationtv/reports';
import { BehaviorSubject } from 'rxjs';
import { z } from 'zod';
import { moqPublishCommand } from '../mediamtx/builders/publishers.ts';
import type { ProgramDestination } from './program-metrics.ts';

// The program MediaMTX: a MediaMTX of the obs runtime's own, between OBS and everything it sends or plays, so OBS can
// come and go without anyone downstream noticing (docs/obs-agent.md):
//
//   cams/<source>  each stream the show places, pushed in by its `moq` relay (ctv-stream.ts) and played by OBS from here.
//                  When the stream's catalog says which tracks it has, the path is always available: while the relay
//                  is down OBS keeps playing, MediaMTX's offline segment in place of the camera.
//   show/program   what OBS streams (its profile's custom server `rtmp://…/show`, key `program`), forwarded to each
//                  channel's ingest. Always available, with the program's own tracks (H.264 and AAC-LC 48 kHz stereo), so
//                  while OBS is gone the forwards carry the offline segment and Twitch never goes offline.
//   previews/<id>  a preview published by MoQ (to conservation.tv): the path pulls `show/program` from this MediaMTX,
//                  and runs the moq CLI reading it over RTMP and publishing it as the preview's broadcast, as the
//                  gateway's publishers are run (runtimes/mediamtx/builders/publishers.ts), restarted whenever it
//                  exits. Its own path, so what the CLI reads is told apart by path from every other preview's.
//
// A preview published by RTMP (to a MediaMTX gateway) is a forward of `show/program` too, after the channels', to the
// publish URL its `connect` gave, carrying its token. Each forward's place in that list is how its metrics are told
// apart (`destinations`, program-metrics.ts).
//
// Everything listens on loopback only, and only loopback may publish or read. The config is rewritten whenever a
// forward, a preview or a camera changes, which a running MediaMTX reloads by itself. Its log goes to the process's
// log file, so every publish, read, and forward is recorded there. Its metrics page is read for the program's reports
// (program-metrics.ts).

/** The path OBS streams to, as the RTMP application and stream key its profile names. */
export const PROGRAM_APP = 'show';
export const PROGRAM_KEY = 'program';
/** The program's path, as MediaMTX names it. */
export const PROGRAM_PATH = `${PROGRAM_APP}/${PROGRAM_KEY}`;

/** The program's tracks: what OBS's profile encodes (settings.ts), and what the forwards carry. */
const PROGRAM_TRACKS: AlwaysAvailableTrack[] = [
  { codec: 'H264' },
  { codec: 'MPEG4Audio', sampleRate: 48_000, channelCount: 2 }
];

/** Where the program MediaMTX listens, on loopback. */
export interface ProgramPorts {
  rtmp: number;
  api: number;
  metrics: number;
}

/** Defaults clear of the gateway MediaMTX's (src/runtimes/mediamtx/ports.ts), as both may run on one machine. */
export const DEFAULT_PROGRAM_PORTS: ProgramPorts = { rtmp: 19_350, api: 19_997, metrics: 19_998 };

/**
 * A forward of the program: the forward (absent from an API that doesn't name it, and then not reported about) and its
 * channel, and the channel's ingest's server URL and stream key.
 */
export interface ProgramForward {
  forwardId: string | undefined;
  channelId: string;
  url: string;
  key: string;
}

/**
 * Where a preview is published: by MoQ, to `connect`, the relay URL carrying its token, as `broadcast`; or pushed by
 * RTMP(S) to `url`, carrying its token as `?jwt=`.
 */
export type PreviewPublish = MoqPreviewPublish | PushedPreviewPublish;

/** A preview published by MoQ: to `connect`, the relay URL carrying its token, as `broadcast`. */
export interface MoqPreviewPublish {
  protocol: 'moq';
  connect: string;
  broadcast: string;
}

/** A preview pushed by RTMP(S): to `url`, carrying its token as `?jwt=`. */
export interface PushedPreviewPublish {
  protocol: 'rtmp' | 'rtmps';
  url: string;
}

/** A preview of the program, and where it is published. */
export interface ProgramPreview {
  previewId: string;
  publish: PreviewPublish;
}

/** A preview pushed by RTMP(S), as a forward of the program. */
interface PushedPreview extends ProgramPreview {
  publish: PushedPreviewPublish;
}

/** A camera's path, as the status reports it. */
export interface CameraStatus {
  /** Whether it falls back to the offline segment while its relay is down. */
  fallback: boolean;
}

/** An installed MediaMTX: its install's ID, and its executable. */
export interface MediamtxInstall {
  id: string;
  path: string;
}

export interface ProgramStatus extends ProcessStatus {
  /** The channels the program is being forwarded to. */
  forwards: string[];
  /** The previews it is published to. */
  previews: string[];
  /** The sources with a path of their own, by source. */
  cameras: Record<string, CameraStatus>;
}

const STOPPED: ProgramStatus = { ...PROCESS_STOPPED, forwards: [], previews: [], cameras: {} };

/** The part of MediaMTX's path status the relays are probed by. */
const PathOnlineSchema = z.object({ online: z.boolean().default(false) });
export type PathOnline = z.output<typeof PathOnlineSchema>;

/** A camera path's name for a source: MediaMTX names take letters, digits and `_-.~` only. */
export function cameraPath(sourceId: string): string {
  return `cams/${sourceId.replaceAll(/[^\w.~-]/gu, '_')}`;
}

/** The path a preview published by MoQ is read from by its moq CLI. */
function previewPath(previewId: string): string {
  return `previews/${previewId}`;
}

/** Whether a preview is pushed by RTMP(S), as a forward of the program, rather than published by MoQ. */
function isPushed(preview: ProgramPreview): preview is PushedPreview {
  return preview.publish.protocol !== 'moq';
}

/** Whether something accepts TCP connections at `port` on loopback. */
export function listening(port: number, signal: AbortSignal): Promise<boolean> {
  return new Promise(resolve => {
    const socket = dial({ host: '127.0.0.1', port, signal });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

/** The program MediaMTX, run from an installed `mediamtx`, in `directory`. */
export class ProgramMediamtx {
  readonly status$ = new BehaviorSubject<ProgramStatus>(STOPPED);
  private readonly process: AttachedProcess;
  private readonly configFile: string;
  private forwards: ProgramForward[] = [];
  private previews: ProgramPreview[] = [];
  /** The moq CLI the MoQ previews are published by, once installed. */
  private moq: string | undefined = undefined;
  /** Each camera's tracks, or null when its catalog could not be read. */
  private readonly cameras = new Map<string, AlwaysAvailableTrack[] | null>();
  private writing: Promise<void> = Promise.resolve();
  private readonly watching;

  constructor(
    private readonly directory: string,
    readonly ports: ProgramPorts
  ) {
    this.configFile = join(directory, 'mediamtx.yml');
    this.process = new AttachedProcess(directory, {
      name: 'mediamtx',
      probe: signal => listening(ports.rtmp, signal)
    });
    this.watching = this.process.status$.subscribe(status => this.update(status));
  }

  /** Where OBS streams the program to, as its custom server and key. */
  get server(): string {
    return `rtmp://127.0.0.1:${String(this.ports.rtmp)}/${PROGRAM_APP}`;
  }

  /** Its metrics page, which the program's reports are read from (program-metrics.ts). */
  get metricsUrl(): string {
    return `http://127.0.0.1:${String(this.ports.metrics)}/metrics`;
  }

  /** Where a camera's relay pushes and OBS plays from. */
  cameraUrl(sourceId: string): string {
    return `rtmp://127.0.0.1:${String(this.ports.rtmp)}/${cameraPath(sourceId)}`;
  }

  /**
   * Whether something publishes to the source's path now: MediaMTX's `online`, which, unlike `ready`, stays false
   * while the path only plays its offline segment. False if MediaMTX doesn't answer, or has no such path.
   */
  async publishing(sourceId: string, signal: AbortSignal): Promise<boolean> {
    const url = `http://127.0.0.1:${String(this.ports.api)}/v3/paths/get/${cameraPath(sourceId)}`;
    try {
      const response = await fetch(url, { signal });
      if (!response.ok) return false;
      const path = PathOnlineSchema.parse(await response.json());
      return path.online;
    } catch {
      return false;
    }
  }

  /**
   * Has MediaMTX running, from `binary` (an install's ID as `key`), with the config written first, its MoQ previews
   * published by `moq`, an installed moq CLI.
   */
  async ensure(binary: MediamtxInstall, moq: string, signal: AbortSignal): Promise<void> {
    this.moq = moq;
    await this.write();
    await this.process.ensure(
      { key: binary.id, binary: binary.path, args: [this.configFile], cwd: this.directory },
      signal
    );
  }

  /** The ingests the program is forwarded to now. */
  forwardsNow(): ProgramForward[] {
    return [...this.forwards];
  }

  /** Forward the program to exactly these ingests. */
  async setForwards(forwards: ProgramForward[]): Promise<void> {
    this.forwards = forwards;
    await this.write();
  }

  /** Publish the program to exactly these previews. */
  async setPreviews(previews: ProgramPreview[]): Promise<void> {
    this.previews = previews;
    await this.write();
  }

  /**
   * What each of `show/program`'s forward destinations is about, in the order the config lists them (MediaMTX's `pos`,
   * from 1): each channel's forward, then each preview pushed by RTMP. Undefined for a forward with no ID.
   */
  destinations(): (ProgramDestination | undefined)[] {
    const forwards = this.forwards.map(({ forwardId }) =>
      forwardId === undefined ? undefined : { kind: 'forward' as const, subject: forwardSubject(forwardId) }
    );
    const pushed = this.previews.filter(isPushed);
    const previews = pushed.map(({ previewId }) => ({ kind: 'preview' as const, subject: previewSubject(previewId) }));
    return [...forwards, ...previews];
  }

  /** The previews published by MoQ, each as a subject by the path its moq CLI reads. */
  moqPreviews(): Map<string, string> {
    const published = this.previews.filter(preview => !isPushed(preview));
    return new Map(published.map(preview => [previewPath(preview.previewId), previewSubject(preview.previewId)]));
  }

  /** Give the source a path, falling back to the offline segment when `tracks` says what the stream carries. */
  async setCamera(sourceId: string, tracks: AlwaysAvailableTrack[] | null): Promise<void> {
    this.cameras.set(sourceId, tracks);
    await this.write();
  }

  async removeCamera(sourceId: string): Promise<void> {
    if (!this.cameras.delete(sourceId)) return;
    await this.write();
  }

  async stop(): Promise<void> {
    await this.process.stop();
  }

  dispose(): void {
    this.watching.unsubscribe();
    this.process.dispose();
  }

  /** Writes the config if it has changed, one write at a time: MediaMTX reloads it whenever it is written. */
  private write(): Promise<void> {
    this.writing = this.writing.then(async () => {
      const config = toYaml(this.config());
      await mkdir(this.directory, { recursive: true });
      const written = await readFile(this.configFile, 'utf8').catch(() => undefined);
      if (written !== config) await writeFile(this.configFile, config, { mode: 0o600 });
      const cameras = Object.fromEntries([...this.cameras].map(([id, tracks]) => [id, { fallback: tracks !== null }]));
      const forwards = this.forwards.map(forward => forward.channelId);
      const previews = this.previews.map(preview => preview.previewId);
      this.update({ forwards, previews, cameras });
    });
    return this.writing;
  }

  private config(): MediamtxConfig {
    // MediaMTX's RTMP(S) destinations take the stream key after `#`; a preview's token is in its URL's query.
    const forwards = this.forwards.map(forward => ({ dest: `${forward.url}#${forward.key}` }));
    const previews = this.previews.flatMap(preview => (isPushed(preview) ? [{ dest: preview.publish.url }] : []));
    const paths: NonNullable<MediamtxConfig['paths']> = {
      [PROGRAM_PATH]: {
        source: 'publisher',
        alwaysAvailable: true,
        alwaysAvailableTracks: PROGRAM_TRACKS,
        forward: [...forwards, ...previews]
      }
    };
    const rtmp = `rtmp://127.0.0.1:${String(this.ports.rtmp)}`;
    for (const preview of this.previews) {
      // A MoQ preview's path, pulling the program, and its CLI, reading the path; none until the CLI is installed.
      if (preview.publish.protocol !== 'moq' || this.moq === undefined) continue;
      const { connect, broadcast } = preview.publish;
      const path = previewPath(preview.previewId);
      paths[path] = {
        source: `${rtmp}/${PROGRAM_PATH}`,
        runOnInit: moqPublishCommand(this.moq, connect, broadcast, `${rtmp}/${path}`),
        runOnInitRestart: true
      };
    }
    for (const [sourceId, tracks] of this.cameras) {
      paths[cameraPath(sourceId)] =
        tracks === null
          ? { source: 'publisher' }
          : { source: 'publisher', alwaysAvailable: true, alwaysAvailableTracks: tracks };
    }
    // A relay can publish before its path is written: always available only once it is.
    paths['~^cams/.+$'] = { source: 'publisher' };
    return {
      logLevel: 'info',
      logDestinations: ['stdout'],
      api: true,
      apiAddress: `127.0.0.1:${String(this.ports.api)}`,
      metrics: true,
      metricsAddress: `127.0.0.1:${String(this.ports.metrics)}`,
      pprof: false,
      playback: false,
      rtsp: false,
      hls: false,
      webrtc: false,
      srt: false,
      moq: false,
      rtmp: true,
      rtmpAddress: `127.0.0.1:${String(this.ports.rtmp)}`,
      rtmpEncryption: 'no',
      authMethod: 'internal',
      authInternalUsers: [
        {
          user: 'any',
          ips: ['127.0.0.1', '::1'],
          permissions: [{ action: 'publish' }, { action: 'read' }, { action: 'api' }, { action: 'metrics' }]
        }
      ],
      paths
    };
  }

  private update(changes: Partial<ProgramStatus>): void {
    this.status$.next({ ...this.status$.value, ...changes });
  }
}
