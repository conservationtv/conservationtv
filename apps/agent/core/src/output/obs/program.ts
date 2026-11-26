import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AttachedProcess, type ProcessStatus, STOPPED as PROCESS_STOPPED } from '@conservationtv/converge/process';
import { type AlwaysAvailableTrack, MediamtxConfigBuilder, pipeline } from '@conservationtv/mediamtx';
import { forwardSubject, previewSubject } from '@conservationtv/reports';
import { getLogger } from '@logtape/logtape';
import { BehaviorSubject } from 'rxjs';
import { z } from 'zod';
import { moqPublishCommand } from '../../binaries/moq.ts';
import { choosePorts, type PortUse, type PortWanted } from '../../machine/ports.ts';
import { common, renderYaml } from '../../mediamtx/config.ts';
import { PortSchema } from '../../gateway/streams/ports.ts';
import { listening } from './loopback.ts';

const logger = getLogger(['agent', 'obs', 'program']);

// The program MediaMTX: a MediaMTX of the obs runtime's own, between OBS and everything it sends or plays, so OBS can
// come and go without anyone downstream noticing (docs/obs-agent.md):
//
//   inputs/<stream>
//                  each stream OBS plays, by whoever drives its scenes, whatever delivers it, so an input never changes
//                  when its delivery does: pushed in by a relay the agent starts when OBS first reads the path, and
//                  stops once nothing has for a while (inputs.ts): `moq export` for MoQ, or a MediaMTX of the relay's
//                  own pulling a gateway's RTSP or RTMP (relay.ts, pull.ts). Any such path is read on demand: its
//                  `runOnDemand` tells the agent it is wanted. No offline segment: the relay's tracks pass through as
//                  the camera sends them, and while it is down OBS has nothing to play.
//   show/program   what OBS streams (its profile's custom server `rtmp://…/show`, key `program`), forwarded to each
//                  channel's ingest. Always available, with the program's own tracks (H.264 and AAC-LC 48 kHz stereo), so
//                  while OBS is gone the forwards carry the offline segment and Twitch never goes offline.
//   previews/<id>  a preview published by MoQ (to conservation.tv): the path pulls `show/program` from this MediaMTX,
//                  and runs the moq CLI reading it over RTMP and publishing it as the preview's broadcast, as the
//                  gateway's publishers are run (gateway/streams/builders/publishers.ts), restarted whenever it
//                  exits. Its own path, so what the CLI reads is told apart by path from every other preview's.
//
// A preview published by RTMP (to a MediaMTX gateway) is a forward of `show/program` too, after the channels', to the
// publish URL its `connect` gave, carrying its token. Each forward's place in that list is how its metrics are told
// apart (`destinations`, program-metrics.ts).
//
// Everything listens on loopback only, and only loopback may publish or read, on ports chosen before each start of it
// as the gateway's are (gateway/streams/ports.ts): last time's if they are free, remembered in its directory, else the
// defaults below, else any free. Only the agent and OBS reach them, and both read them as they do. The config is assembled by the common
// step (mediamtx/config.ts) and the program's own below, and rewritten whenever a forward or a preview changes, which
// a running MediaMTX reloads by itself. Inputs never change it: they are all read through the one pattern. Its log goes
// to the process's log file, so every
// publish, read, and forward is recorded there. Its metrics page is read for the program's reports (program-metrics.ts).

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

/** How long a reader waits for an input's relay to start: asking for a session and starting `moq` take a few seconds. */
const INPUT_START_TIMEOUT = '30s';
/** How long an input read on demand is wanted after its last reader goes. */
const INPUT_CLOSE_AFTER = '10s';

/** Where the program MediaMTX listens, on loopback. */
export interface ProgramPorts {
  rtmp: number;
  api: number;
  metrics: number;
}

/** Defaults clear of the gateway MediaMTX's (gateway/streams/ports.ts), as both may run on one machine. */
export const DEFAULT_PROGRAM_PORTS: ProgramPorts = { rtmp: 19_350, api: 19_997, metrics: 19_998 };

/** How every one of the program MediaMTX's servers listens: on loopback. */
const LOOPBACK_TCP: PortUse = { transport: 'tcp', scope: 'loopback' };

/** Where the ports chosen last time are kept, in the program's directory. */
const REMEMBERED_PORTS_FILE = 'ports.json';
const RememberedPortsSchema = z.object({ rtmp: PortSchema, api: PortSchema, metrics: PortSchema }).partial().catch({});
type RememberedPorts = z.output<typeof RememberedPortsSchema>;

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

/** A preview published by MoQ: to `connect`, the relay URL carrying its token as `?jwt=`, as `broadcast`. */
const MoqPreviewPublishSchema = z.object({ protocol: z.literal('moq'), connect: z.string(), broadcast: z.string() });
export type MoqPreviewPublish = z.output<typeof MoqPreviewPublishSchema>;

/** A preview pushed by RTMP(S): to `url`, carrying its token as `?jwt=`. */
const PushedPreviewPublishSchema = z.object({ protocol: z.enum(['rtmp', 'rtmps']), url: z.string() });
export type PushedPreviewPublish = z.output<typeof PushedPreviewPublishSchema>;

/**
 * Where a preview is published, by MoQ or pushed by RTMP(S), as the `obs` key's spec gives it (runtime.ts), from its
 * `connect` (output/configuration.ts).
 */
export const PreviewPublishSchema = z.discriminatedUnion('protocol', [
  MoqPreviewPublishSchema,
  PushedPreviewPublishSchema
]);
export type PreviewPublish = z.output<typeof PreviewPublishSchema>;

/** A preview of the program, and where it is published. */
export const ProgramPreviewSchema = z.object({ previewId: z.string(), publish: PreviewPublishSchema });
export type ProgramPreview = z.output<typeof ProgramPreviewSchema>;

/** A preview pushed by RTMP(S), as a forward of the program. */
interface PushedPreview extends ProgramPreview {
  publish: PushedPreviewPublish;
}

/** A forward destination of `show/program`: a channel's forward, or a preview pushed by RTMP, and its subject. */
export interface ProgramDestination {
  kind: 'forward' | 'preview';
  subject: string;
}

/** An input's path, as the status reports it. */
export interface InputStatus {
  /** Whether it falls back to an offline segment while its relay is down: never, now; kept for the status contract. */
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
  /** The inputs being relayed, by path. */
  inputs: Record<string, InputStatus>;
}

const STOPPED: ProgramStatus = { ...PROCESS_STOPPED, forwards: [], previews: [], inputs: {} };

/** The part of MediaMTX's path status the relays are probed by. */
const PathOnlineSchema = z.object({ online: z.boolean().default(false) });
export type PathOnline = z.output<typeof PathOnlineSchema>;

/** Where an input's paths are: `inputs/<stream>`, a UUID. */
const INPUT_APP = 'inputs';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** Every input's path, as a MediaMTX path pattern, whose group is the stream. */
const INPUT_PATTERN = `~^${INPUT_APP}/(${UUID})$`;
const INPUT_PATH = new RegExp(INPUT_PATTERN.slice(1), 'u');

/** The path OBS reads a stream at. */
export function inputPath(streamId: string): string {
  return `${INPUT_APP}/${streamId}`;
}

/** The stream an input's path names, if it is one. */
export function inputOf(path: string): string | undefined {
  const match = INPUT_PATH.exec(path);
  return match === null ? undefined : match[1];
}

/** The path a preview published by MoQ is read from by its moq CLI. */
function previewPath(previewId: string): string {
  return `previews/${previewId}`;
}

/** Whether a preview is pushed by RTMP(S), as a forward of the program, rather than published by MoQ. */
function isPushed(preview: ProgramPreview): preview is PushedPreview {
  return preview.publish.protocol !== 'moq';
}

/** What the program MediaMTX serves: where it listens, and what it forwards, publishes and plays. */
interface ProgramServing {
  ports: ProgramPorts;
  forwards: readonly ProgramForward[];
  previews: readonly ProgramPreview[];
  /** The moq CLI the MoQ previews are published by; none until it is installed. */
  moq: string | undefined;
  /** What MediaMTX runs to tell the agent an input is wanted (inputs.ts); none reads inputs until it is set. */
  demand: string | undefined;
}

/**
 * RTMP alone, on loopback, and only loopback may publish, read, or use the control API and metrics page. Every other
 * server is off (pprof, playback and MoQ by the common step).
 */
const programServer = new MediamtxConfigBuilder<ProgramServing>(({ ports }, config) => {
  config.rtsp = false;
  config.hls = false;
  config.webrtc = false;
  config.srt = false;
  config.rtmp = true;
  config.rtmpAddress = `127.0.0.1:${String(ports.rtmp)}`;
  config.rtmpEncryption = 'no';
  config.authMethod = 'internal';
  config.authInternalUsers = [
    {
      user: 'any',
      ips: ['127.0.0.1', '::1'],
      permissions: [{ action: 'publish' }, { action: 'read' }, { action: 'api' }, { action: 'metrics' }]
    }
  ];
});

/** `show/program` and its forwards, each MoQ preview's path, and the inputs', once they are read on demand. */
const programPaths = new MediamtxConfigBuilder<ProgramServing>((serving, config) => {
  // MediaMTX's RTMP(S) destinations take the stream key after `#`; a preview's token is in its URL's query.
  const forwards = serving.forwards.map(forward => ({ dest: `${forward.url}#${forward.key}` }));
  const previews = serving.previews.flatMap(preview => (isPushed(preview) ? [{ dest: preview.publish.url }] : []));
  config.paths[PROGRAM_PATH] = {
    source: 'publisher',
    alwaysAvailable: true,
    alwaysAvailableTracks: PROGRAM_TRACKS,
    forward: [...forwards, ...previews]
  };
  const rtmp = `rtmp://127.0.0.1:${String(serving.ports.rtmp)}`;
  for (const preview of serving.previews) {
    // A MoQ preview's path, pulling the program, and its CLI, reading the path; none until the CLI is installed.
    if (preview.publish.protocol !== 'moq' || serving.moq === undefined) continue;
    const { connect, broadcast } = preview.publish;
    const path = previewPath(preview.previewId);
    config.paths[path] = {
      source: `${rtmp}/${PROGRAM_PATH}`,
      runOnInit: moqPublishCommand(serving.moq, connect, broadcast, `${rtmp}/${path}`),
      runOnInitRestart: true
    };
  }
  if (serving.demand === undefined) return;
  config.paths[INPUT_PATTERN] = {
    source: 'publisher',
    runOnDemand: serving.demand,
    runOnDemandRestart: true,
    runOnDemandStartTimeout: INPUT_START_TIMEOUT,
    runOnDemandCloseAfter: INPUT_CLOSE_AFTER
  };
});

const programConfig = pipeline(common, programServer, programPaths);

/** The program MediaMTX, run from an installed `mediamtx`, in `directory`. */
export class ProgramMediamtx {
  readonly status$ = new BehaviorSubject<ProgramStatus>(STOPPED);
  private readonly process: AttachedProcess;
  private readonly configFile: string;
  private forwards: ProgramForward[] = [];
  private previews: ProgramPreview[] = [];
  /** The moq CLI the MoQ previews are published by, once installed. */
  private moq: string | undefined = undefined;
  /** The inputs being relayed, by path, for the status alone: each is read on demand by the one path pattern. */
  private readonly inputs = new Set<string>();
  /** What MediaMTX runs to tell the agent an input is wanted (inputs.ts); none reads inputs until it is set. */
  private demand: string | undefined = undefined;
  private writing: Promise<void> = Promise.resolve();
  private readonly watching;
  /** Where it listens: chosen before each start of it, and the same while it runs. */
  private current: ProgramPorts;
  /** Whether the ports chosen last time have been read, for an orphaned MediaMTX to be found on. */
  private recalled = false;

  constructor(
    private readonly directory: string,
    /** Where it listens unless they are taken. */
    private readonly defaults: ProgramPorts,
    /** Variables MediaMTX runs with, on top of the agent's: what the Node its demand launcher runs by needs. */
    private readonly env: Record<string, string> = {}
  ) {
    this.current = defaults;
    this.configFile = join(directory, 'mediamtx.yml');
    this.process = new AttachedProcess(directory, {
      name: 'mediamtx',
      probe: signal => listening(this.current.rtmp, signal)
    });
    this.watching = this.process.status$.subscribe(status => this.update(status));
  }

  /** Where it listens now. */
  get ports(): ProgramPorts {
    return this.current;
  }

  /** Where OBS streams the program to, as its custom server and key. */
  get server(): string {
    return `rtmp://127.0.0.1:${String(this.ports.rtmp)}/${PROGRAM_APP}`;
  }

  /** Its metrics page, which the program's reports are read from (program-metrics.ts). */
  get metricsUrl(): string {
    return `http://127.0.0.1:${String(this.ports.metrics)}/metrics`;
  }

  /** Where an input's relay pushes and OBS plays from: a path of this MediaMTX, by its name. */
  pathUrl(path: string): string {
    return `rtmp://127.0.0.1:${String(this.ports.rtmp)}/${path}`;
  }

  /** Where OBS reads any stream, with `{streamId}` in place of the stream. */
  get inputTemplate(): string {
    return this.pathUrl(inputPath('{streamId}'));
  }

  /**
   * Whether something publishes to the path now: MediaMTX's `online`, which, unlike `ready`, stays false while the
   * path only plays its offline segment. False if MediaMTX doesn't answer, or has no such path.
   */
  async publishing(path: string, signal: AbortSignal): Promise<boolean> {
    const url = `http://127.0.0.1:${String(this.ports.api)}/v3/paths/get/${path}`;
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
    if (!this.recalled) {
      this.recalled = true;
      this.current = { ...this.current, ...(await this.remembered()) };
    }
    await this.write();
    const { directory, env } = this;
    const prepare = () => this.prepare();
    await this.process.ensure(
      { key: binary.id, binary: binary.path, args: [this.configFile], cwd: directory, env, prepare },
      signal
    );
  }

  /**
   * Chooses its ports before it starts, once the one before is gone (converge's `prepare`), and writes its config for
   * them: last time's if free, else the defaults, else any free.
   */
  private async prepare(): Promise<void> {
    const remembered = await this.remembered();
    const wanted = (role: keyof ProgramPorts): PortWanted<keyof ProgramPorts> => {
      const preferred = [...new Set([remembered[role], this.defaults[role]])].filter(port => port !== undefined);
      return { role, use: LOOPBACK_TCP, wish: { preferred } };
    };
    const { port, moved } = await choosePorts([wanted('rtmp'), wanted('api'), wanted('metrics')], {});
    const ports: ProgramPorts = { rtmp: port('rtmp'), api: port('api'), metrics: port('metrics') };
    for (const { role, wanted, chosen } of moved) {
      logger.warn('The program MediaMTX {role} port {wanted} is unavailable, so it is on {chosen}', {
        role,
        wanted,
        chosen
      });
    }
    this.current = ports;
    await mkdir(this.directory, { recursive: true });
    await writeFile(join(this.directory, REMEMBERED_PORTS_FILE), JSON.stringify(ports));
    await this.write();
  }

  /** The ports chosen last time, as far as they can still be read. */
  private async remembered(): Promise<RememberedPorts> {
    const text = await readFile(join(this.directory, REMEMBERED_PORTS_FILE), 'utf8').catch(() => undefined);
    if (text === undefined) return {};
    try {
      return RememberedPortsSchema.parse(JSON.parse(text));
    } catch {
      return {};
    }
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

  /** Read inputs on demand, running `command` to say each is wanted; or, with none, read none. */
  async setDemand(command: string | undefined): Promise<void> {
    this.demand = command;
    await this.write();
  }

  /** Report the input as relayed. Its path is the pattern's: the config doesn't change. */
  setInput(path: string): void {
    this.inputs.add(path);
    this.reportInputs();
  }

  removeInput(path: string): void {
    if (!this.inputs.delete(path)) return;
    this.reportInputs();
  }

  private reportInputs(): void {
    this.update({ inputs: Object.fromEntries([...this.inputs].map(path => [path, { fallback: false }])) });
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
      const { ports, forwards, previews, moq, demand } = this;
      const config = await renderYaml(programConfig, { ports, forwards, previews, moq, demand });
      await mkdir(this.directory, { recursive: true });
      const written = await readFile(this.configFile, 'utf8').catch(() => undefined);
      if (written !== config) await writeFile(this.configFile, config, { mode: 0o600 });
      this.update({
        forwards: forwards.map(forward => forward.channelId),
        previews: previews.map(preview => preview.previewId)
      });
    });
    return this.writing;
  }

  private update(changes: Partial<ProgramStatus>): void {
    this.status$.next({ ...this.status$.value, ...changes });
  }
}
