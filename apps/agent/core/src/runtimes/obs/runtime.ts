import { join } from 'node:path';
import { BinaryStore, type Installed } from '@conservationtv/converge/binaries';
import { AttachedProcess, type ProcessStatus, STOPPED as PROCESS_STOPPED } from '@conservationtv/converge/process';
import { programSubject, recorderSubject } from '@conservationtv/reports';
import type { Client, DeviceIdentity } from '@conservationtv/studio-sdk';
import { getLogger } from '@logtape/logtape';
import type { Snapshot, Target, TargetPhase } from '@strangecyan/vignette';
import { obsTarget } from '@strangecyan/vignette/obs';
import { BehaviorSubject, type Subscription } from 'rxjs';
import { z } from 'zod';
import { type MediamtxManifest, mediamtxBinary } from '../mediamtx/binaries/mediamtx.ts';
import { type MoqManifest, moqBinary } from '../mediamtx/binaries/moq.ts';
import { type ObsManifest, obsBinary } from './binaries/obs.ts';
import { ctvStreamObs } from './ctv-stream.ts';
import {
  listening,
  PROGRAM_KEY,
  ProgramMediamtx,
  type ProgramForward,
  type ProgramPorts,
  type ProgramStatus
} from './program.ts';
import { ProgramMetrics, type ProgramMetricsStatus } from './program-metrics.ts';
import { obsLaunch, websocketPassword, writeObsProfile, writeObsSettings } from './settings.ts';
import { showStream } from './show-stream.ts';
import { type RecordingState, type RecordingTarget, type StreamingState, StreamingWatchdog } from './streaming.ts';

const logger = getLogger(['agent', 'obs']);

/** What the program is encoded as, as the studio API plans it. */
const OutputSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fps: z.number().int().positive(),
  bitrateKbps: z.number().int().positive(),
  keyframeSeconds: z.number().int().positive()
});
export type Output = z.output<typeof OutputSchema>;

/** Until the API plans one: 1080p30 at 6000 kbps with 2-second keyframes, what Twitch takes. */
const DEFAULT_OUTPUT: Output = { width: 1920, height: 1080, fps: 30, bitrateKbps: 6000, keyframeSeconds: 2 };

/**
 * Where a preview is published, as studio-configuration.ts resolves its `connect`: by MoQ, to the relay URL carrying
 * its token, as a broadcast; or pushed by RTMP(S) to a URL carrying its token.
 */
const ObsPreviewPublishSchema = z.discriminatedUnion('protocol', [
  z.object({ protocol: z.literal('moq'), connect: z.string(), broadcast: z.string() }),
  z.object({ protocol: z.enum(['rtmp', 'rtmps']), url: z.string() })
]);
export type ObsPreviewPublish = z.output<typeof ObsPreviewPublishSchema>;

/**
 * The show to send out: the one the agent is the output of, followed at `url`, how to encode it, the channels to
 * forward it to, whose ingests the agent asks for, the previews to publish it to, the recorder recording it, and the
 * subject its reports are about (src/configuration in the studio API). A forward with no `forwardId`, from an API that
 * doesn't name it, is forwarded to but not reported about; with no `program`, the reports are about `program:<show>`.
 * What the channels' platforms say of them is the `channels` key's to report (runtimes/channel-stats.ts).
 */
export const ObsSpecSchema = z.object({
  show: z.object({ id: z.string(), url: z.url() }),
  output: OutputSchema.default(DEFAULT_OUTPUT),
  forwards: z
    .array(
      z.object({
        organisationId: z.string(),
        channelId: z.string(),
        forwardId: z.string().optional()
      })
    )
    .default([]),
  previews: z.array(z.object({ previewId: z.string(), publish: ObsPreviewPublishSchema })).default([]),
  recording: z.object({ recorderId: z.string(), kind: z.string() }).optional(),
  program: z.object({ subjectId: z.string() }).optional()
});
export type ObsSpec = z.output<typeof ObsSpecSchema>;

/** How often to ask for the channels' ingests again: a stream key reset on Twitch is picked up within this. */
const INGEST_REFRESH_MS = 30 * 60_000;
/** How soon to ask again when an ingest could not be read. */
const INGEST_RETRY_MS = 60_000;

/** The room the runtime is given, and the releases it runs. */
export interface ObsRuntimeOptions {
  /** A directory of its own: binaries under `binaries/`, OBS's log and pidfile, its macOS home, and relays. */
  directory: string;
  /** The OBS release to run. */
  binary: ObsManifest;
  /** The moq CLI release the streams are relayed by. */
  moq: MoqManifest;
  /** The MediaMTX release the program and the streams go through. */
  mediamtx: MediamtxManifest;
  /** Where the program MediaMTX listens, on loopback. */
  programPorts: ProgramPorts;
  /** The port obs-websocket serves on, on this machine. */
  websocketPort: number;
  /** The studio API, as the agent's device, for read sessions and the channels' ingests. */
  studio: Client;
  /** The agent's identity, which following the show is signed as. */
  identity: DeviceIdentity;
}

export interface ObsStatus extends ProcessStatus {
  /** The version of OBS running, or being started. */
  version: string | null;
  /** Whether a binary is being downloaded and checked. */
  installing: boolean;
  /** The show being sent out, and how far OBS has caught up with it. */
  show: string | null;
  phase: TargetPhase | null;
  /** Whether OBS is streaming the program. */
  streaming: StreamingState;
  /** Whether OBS is recording the program, while the show has a recorder. */
  recording: RecordingState | null;
  /** The program MediaMTX, and the channels and previews it sends to. */
  program: ProgramStatus | null;
  /** The program's reports. */
  reports: ProgramMetricsStatus | null;
}

const STOPPED: ObsStatus = {
  ...PROCESS_STOPPED,
  version: null,
  installing: false,
  show: null,
  phase: null,
  streaming: null,
  recording: null,
  program: null,
  reports: null
};

/** OBS's executable name, as `ps` reports it. */
const PROCESS_NAME = process.platform === 'win32' ? 'obs64' : 'OBS';

/** The only recorder kind there is: OBS recording the program alongside streaming it. */
const OBS_RECORDER = 'obs';

/** A first start scans plugins, and macOS checks a new app: OBS may take a while to answer. */
const READY_TIMEOUT_MS = 60_000;

/** The target sending one show out, and how to stop it following. */
interface Following {
  show: ObsSpec['show'];
  target: Target;
  stop: () => void;
  watching: () => void;
}

/**
 * The `obs` key, fulfilled by an OBS of the agent's own: installed by the runtime, started with a configuration it
 * writes (obs-websocket on its port, with its password), and lived and died with the agent. Vignette's OBS target
 * converges it to the show the spec names, following the show's stream; the `ctv-stream` plugin plays the streams the
 * show places. OBS runs on Windows and macOS only (binaries/obs.ts).
 *
 * The target touches only what it made (`vignette/<show>/…` scenes and inputs), so anything an operator adds in OBS
 * stays. Stopping OBS is something it takes for a crash, so each launch clears that first (settings.ts).
 */
export class ObsRuntime {
  readonly status$ = new BehaviorSubject<ObsStatus>(STOPPED);
  private readonly binaries: BinaryStore;
  private readonly process: AttachedProcess;
  private readonly program: ProgramMediamtx;
  private readonly metrics: ProgramMetrics;
  private readonly watching: Subscription[];
  private following: Following | undefined = undefined;
  private watchdog: StreamingWatchdog | undefined = undefined;
  /** The OBS scene the followed show is on, as its latest snapshot says: what the watchdog keeps on program. */
  private programScene: string | undefined = undefined;
  private forwards: ObsSpec['forwards'] = [];
  private refresh: ReturnType<typeof setTimeout> | undefined = undefined;

  constructor(private readonly options: ObsRuntimeOptions) {
    this.binaries = new BinaryStore({ directory: join(options.directory, 'binaries') });
    this.process = new AttachedProcess(options.directory, {
      name: PROCESS_NAME,
      probe: signal => listening(options.websocketPort, signal),
      readyTimeoutMs: READY_TIMEOUT_MS
    });
    this.program = new ProgramMediamtx(join(options.directory, 'program'), options.programPorts);
    this.metrics = new ProgramMetrics(this.program, () => this.watchdog?.reading$.value ?? null);
    this.watching = [
      this.process.status$.subscribe(status => this.update(status)),
      this.program.status$.subscribe(program => this.update({ program })),
      this.metrics.status$.subscribe(reports => this.update({ reports }))
    ];
  }

  /**
   * Installs OBS, moq and MediaMTX if need be; has the program MediaMTX running, forwarding to the spec's channels and
   * publishing to its previews; has OBS running with obs-websocket on and the agent's profile, streaming to it; then
   * the target following the spec's show, the watchdog keeping OBS streaming (and recording, with a recorder), and
   * the program's reports. Resolves once OBS answers; the target converges on its own, and reconnects to OBS when it
   * restarts.
   */
  async execute(spec: ObsSpec, signal: AbortSignal): Promise<void> {
    if (process.platform !== 'win32' && process.platform !== 'darwin') {
      throw new Error(`OBS agents run on Windows and macOS, not ${process.platform}`);
    }
    const { directory, websocketPort } = this.options;
    const installed = await this.installed(obsBinary, this.options.binary, signal);
    this.update({ version: installed.version });
    const moq = await this.installed(moqBinary, this.options.moq, signal);
    const mediamtx = await this.installed(mediamtxBinary, this.options.mediamtx, signal);
    await this.program.ensure(mediamtx, moq.path, signal);
    await this.forward(spec.forwards);
    await this.program.setPreviews(spec.previews);
    const password = await websocketPassword(directory);
    const launch = obsLaunch(installed.path, directory);
    await writeObsSettings(launch.config, websocketPort, password);
    await writeObsProfile(launch.config, spec.output, { server: this.program.server, key: PROGRAM_KEY });
    await this.process.ensure(
      { key: installed.id, binary: installed.path, args: launch.args, cwd: launch.cwd, env: launch.env },
      signal
    );
    this.follow(spec.show, password, moq.path);
    const watchdog = this.watch(password);
    const recording = this.recordingTarget(spec.recording);
    watchdog.record(recording);
    const program = spec.program?.subjectId ?? programSubject(spec.show.id);
    const recorder = recording === undefined ? undefined : recorderSubject(recording.recorderId);
    this.metrics.apply({ program, recorder });
    for (const binary of [installed, moq, mediamtx]) await this.binaries.prune(binary, { spare: 1 });
  }

  /**
   * Forward the program to the channels' ingests, asked for now and again every half hour. A channel whose ingest
   * can't be read keeps the ingest it last had, if any, and is asked for again a minute on.
   */
  private async forward(forwards: ObsSpec['forwards']): Promise<void> {
    clearTimeout(this.refresh);
    this.forwards = forwards;
    const known = new Map(this.program.forwardsNow().map(forward => [forward.channelId, forward]));
    const resolved: ProgramForward[] = [];
    let failed = false;
    for (const forward of forwards) {
      const ingest = await this.ingest(forward).catch(logIngestFailure(forward.channelId));
      if (ingest === undefined) failed = true;
      const using = ingest ?? known.get(forward.channelId);
      if (using !== undefined) resolved.push({ ...using, forwardId: forward.forwardId });
    }
    await this.program.setForwards(resolved);
    const delay = failed ? INGEST_RETRY_MS : INGEST_REFRESH_MS;
    this.refresh = setTimeout(() => void this.forward(this.forwards), delay);
  }

  /** The channel's ingest, as the device: a stream key it keeps in memory only. */
  private async ingest(forward: ObsSpec['forwards'][number]): Promise<ProgramForward> {
    const { studio } = this.options;
    const ingest = await studio.organisations.channels.ingest.v1({
      id: forward.organisationId,
      channelId: forward.channelId
    });
    if (ingest instanceof Error) throw ingest;
    return { forwardId: forward.forwardId, channelId: forward.channelId, url: ingest.url, key: ingest.key };
  }

  /** The watchdog keeping OBS streaming, made once with the password it connects with. */
  private watch(password: string): StreamingWatchdog {
    if (this.watchdog !== undefined) return this.watchdog;
    const url = `ws://127.0.0.1:${String(this.options.websocketPort)}`;
    const watchdog = new StreamingWatchdog(url, password, () => this.programScene);
    this.watching.push(watchdog.state$.subscribe(streaming => this.update({ streaming })));
    this.watching.push(watchdog.recording$.subscribe(recording => this.update({ recording })));
    watchdog.start();
    this.watchdog = watchdog;
    return watchdog;
  }

  /**
   * Where OBS records for the spec's recorder: a directory of the recorder's own in the runtime's. None without a
   * recorder, or for a kind this agent doesn't know.
   */
  private recordingTarget(recording: ObsSpec['recording']): RecordingTarget | undefined {
    if (recording === undefined) return undefined;
    const { recorderId, kind } = recording;
    if (kind !== OBS_RECORDER) {
      logger.error('Recorder {recorderId} is of a kind this agent cannot record: {kind}', { recorderId, kind });
      return undefined;
    }
    return { recorderId, directory: join(this.options.directory, 'recordings', recorderId) };
  }

  /** The install of `manifest`, downloading it if need be. */
  private async installed(
    binary: typeof obsBinary | typeof moqBinary | typeof mediamtxBinary,
    manifest: ObsManifest | MoqManifest | MediamtxManifest,
    signal: AbortSignal
  ): Promise<Installed> {
    const found = await this.binaries.find(manifest);
    if (found !== undefined) return found;
    this.update({ installing: true });
    try {
      return await this.binaries.install(binary, manifest, signal);
    } finally {
      this.update({ installing: false });
    }
  }

  /** The target following `show`: kept while it is the same show, replaced for another. */
  private follow(show: ObsSpec['show'], password: string, moq: string): void {
    if (this.following?.show.id === show.id && this.following.show.url === show.url) return;
    this.unfollow();
    const { studio, identity, directory, websocketPort } = this.options;
    const target = obsTarget({
      url: `ws://127.0.0.1:${String(websocketPort)}`,
      password,
      dir: join(directory, 'vignette'),
      sources: [ctvStreamObs({ studio, moq, program: this.program, directory: join(directory, 'relays') })]
    });
    const stream = showStream(show.url, identity, snapshot => {
      this.programScene = programSceneOf(snapshot);
    });
    const stop = target.follow(stream);
    const watching = target.subscribe(() => this.update({ phase: target.status.phase }));
    this.following = { show, target, stop, watching };
    this.update({ show: show.id, phase: target.status.phase });
  }

  private unfollow(): void {
    const following = this.following;
    this.following = undefined;
    if (following === undefined) return;
    following.watching();
    following.stop();
    void following.target.dispose();
    this.programScene = undefined;
    this.update({ show: null, phase: null });
  }

  /** The key is absent: stop following and watching, and stop OBS, then the program MediaMTX. */
  async finalize(): Promise<void> {
    clearTimeout(this.refresh);
    this.metrics.stop();
    this.unfollow();
    await this.watchdog?.stop();
    this.watchdog = undefined;
    await this.process.stop();
    await this.program.stop();
    this.update({ program: null });
  }

  /** The agent is stopping, and OBS and the program MediaMTX go with it. */
  dispose(): void {
    clearTimeout(this.refresh);
    this.metrics.stop();
    this.unfollow();
    void this.watchdog?.stop();
    for (const subscription of this.watching) subscription.unsubscribe();
    this.process.dispose();
    this.program.dispose();
  }

  private update(changes: Partial<ObsStatus>): void {
    this.status$.next({ ...this.status$.value, ...changes });
  }
}

/**
 * The OBS scene a snapshot goes out on: its active scene, or its first when it names none, by vignette's name for it
 * (`vignette/<show>/<scene>`, which `@strangecyan/vignette/obs` doesn't export). Undefined for a show with no scenes.
 */
function programSceneOf(snapshot: Snapshot): string | undefined {
  const scene = snapshot.activeScene ?? snapshot.scenes[0]?.id;
  return scene === undefined ? undefined : `vignette/${snapshot.id}/${scene}`;
}

/** Logs a channel's ingest failing, for a promise's `catch`: the forward keeps the ingest it last had. */
function logIngestFailure(channelId: string) {
  return (error: Error): undefined => {
    logger.error('The ingest for channel {channelId} is unavailable: {error}', { channelId, error });
    return undefined;
  };
}
