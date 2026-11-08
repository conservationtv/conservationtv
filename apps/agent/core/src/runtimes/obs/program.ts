import { connect as dial } from 'node:net';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AttachedProcess, type ProcessStatus, STOPPED as PROCESS_STOPPED } from '@conservationtv/converge/process';
import { type AlwaysAvailableTrack, type MediamtxConfig, toYaml } from '@conservationtv/mediamtx';
import { BehaviorSubject } from 'rxjs';

// The program MediaMTX: a MediaMTX of the obs runtime's own, between OBS and everything it sends or plays, so OBS can
// come and go without anyone downstream noticing (docs/obs-agent.md):
//
//   cams/<source>  each stream the show places, pushed in by its `moq` relay (ctv-stream.ts) and played by OBS from here.
//                  When the stream's catalog says which tracks it has, the path is always available: while the relay
//                  is down OBS keeps playing, MediaMTX's offline segment in place of the camera.
//   show/program   what OBS streams (its profile's custom server `rtmp://…/show`, key `program`), forwarded to each
//                  channel's ingest. Always available, with the program's own tracks (H.264 and AAC-LC 48 kHz stereo), so
//                  while OBS is gone the forwards carry the offline segment and Twitch never goes offline.
//
// Everything listens on loopback only, and only loopback may publish or read. The config is rewritten whenever a
// forward or a camera changes, which a running MediaMTX reloads by itself. Its log goes to the process's log file, so
// every publish, read, and forward is recorded there.

/** The path OBS streams to, as the RTMP application and stream key its profile names. */
export const PROGRAM_APP = 'show';
export const PROGRAM_KEY = 'program';

/** The program's tracks: what OBS's profile encodes (settings.ts), and what the forwards carry. */
const PROGRAM_TRACKS: AlwaysAvailableTrack[] = [
  { codec: 'H264' },
  { codec: 'MPEG4Audio', sampleRate: 48_000, channelCount: 2 }
];

/** Where the program MediaMTX listens, on loopback. */
export interface ProgramPorts {
  rtmp: number;
  api: number;
}

/** Defaults clear of the gateway MediaMTX's (src/runtimes/mediamtx/ports.ts), as both may run on one machine. */
export const DEFAULT_PROGRAM_PORTS: ProgramPorts = { rtmp: 19_350, api: 19_997 };

/** A forward of the program: the channel, and its ingest's server URL and stream key. */
export interface ProgramForward {
  channelId: string;
  url: string;
  key: string;
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
  /** The sources with a path of their own, by source. */
  cameras: Record<string, CameraStatus>;
}

const STOPPED: ProgramStatus = { ...PROCESS_STOPPED, forwards: [], cameras: {} };

/** A camera path's name for a source: MediaMTX names take letters, digits and `_-.~` only. */
export function cameraPath(sourceId: string): string {
  return `cams/${sourceId.replaceAll(/[^\w.~-]/gu, '_')}`;
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

  /** Where a camera's relay pushes and OBS plays from. */
  cameraUrl(sourceId: string): string {
    return `rtmp://127.0.0.1:${String(this.ports.rtmp)}/${cameraPath(sourceId)}`;
  }

  /** Has MediaMTX running, from `binary` (an install's ID as `key`), with the config written first. */
  async ensure(binary: MediamtxInstall, signal: AbortSignal): Promise<void> {
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
      this.update({ forwards: this.forwards.map(forward => forward.channelId), cameras });
    });
    return this.writing;
  }

  private config(): MediamtxConfig {
    const paths: NonNullable<MediamtxConfig['paths']> = {
      [`${PROGRAM_APP}/${PROGRAM_KEY}`]: {
        source: 'publisher',
        alwaysAvailable: true,
        alwaysAvailableTracks: PROGRAM_TRACKS,
        // MediaMTX's RTMP(S) destinations take the stream key after `#`.
        forward: this.forwards.map(forward => ({ dest: `${forward.url}#${forward.key}` }))
      }
    };
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
      metrics: false,
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
          permissions: [{ action: 'publish' }, { action: 'read' }, { action: 'api' }]
        }
      ],
      paths
    };
  }

  private update(changes: Partial<ProgramStatus>): void {
    this.status$.next({ ...this.status$.value, ...changes });
  }
}
