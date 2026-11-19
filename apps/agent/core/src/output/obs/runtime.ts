import { join } from 'node:path';
import { BinaryStore, type Installed } from '@conservationtv/converge/binaries';
import { AttachedProcess, type ProcessStatus, STOPPED as PROCESS_STOPPED } from '@conservationtv/converge/process';
import { recorderSubject } from '@conservationtv/reports';
import type { Client } from '@conservationtv/studio-sdk';
import { getLogger } from '@logtape/logtape';
import { BehaviorSubject, type Subscription } from 'rxjs';
import { z } from 'zod';
import { type MediamtxManifest, mediamtxBinary } from '../../binaries/mediamtx.ts';
import { type MoqManifest, moqBinary } from '../../binaries/moq.ts';
import { type ObsManifest, obsBinary } from '../../binaries/obs.ts';
import { InputRelays, type InputsStatus } from './inputs.ts';
import { listening } from './loopback.ts';
import {
  PROGRAM_KEY,
  ProgramMediamtx,
  type ProgramForward,
  type ProgramPorts,
  ProgramPreviewSchema,
  type ProgramStatus
} from './program.ts';
import { ProgramMetrics, type ProgramMetricsStatus } from './program-metrics.ts';
import { obsLaunch, websocketPassword, writeObsProfile, writeObsSettings } from './settings.ts';
import {
  type ProgramScene,
  type RecordingState,
  type RecordingTarget,
  type StreamingState,
  StreamingWatchdog
} from './watchdog.ts';

const logger = getLogger(['agent', 'obs']);

/** What the programme is encoded as, as the studio API plans it. */
const EncodingSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fps: z.number().int().positive(),
  bitrateKbps: z.number().int().positive(),
  keyframeSeconds: z.number().int().positive()
});
export type Encoding = z.output<typeof EncodingSchema>;

/**
 * Who drives OBS's scenes: `show`, the agent's `show` key (output/show/), in the agent's own scene collection, or
 * `external`, something outside the studio, in a collection of its own the agent never touches.
 */
const ControlSchema = z.enum(['show', 'external']);
export type Control = z.output<typeof ControlSchema>;

/**
 * The output to send out (src/configuration in the studio API): the output, its organisation, and who drives its
 * scenes; how to encode its programme, the channels to forward it to, whose ingests the agent asks for, the previews
 * to publish it to, the recorder recording it, and the subject its reports are about. What the channels' platforms say
 * of them is the `channels` key's to report (output/channels/); following a show is the `show` key's (output/show/).
 */
export const ObsSpecSchema = z.object({
  output: z.object({ id: z.string(), organisationId: z.string(), control: ControlSchema }),
  encoding: EncodingSchema,
  forwards: z.array(z.object({ organisationId: z.string(), channelId: z.string(), forwardId: z.string() })),
  previews: z.array(ProgramPreviewSchema),
  recording: z.object({ recorderId: z.string(), kind: z.string() }).optional(),
  program: z.object({ subjectId: z.string() })
});
export type ObsSpec = z.output<typeof ObsSpecSchema>;

/** The scene collection OBS runs under each control: never the same, so neither overwrites the other's scenes. */
const COLLECTIONS = { show: 'vignette', external: 'external' } as const satisfies Record<Control, string>;

/** How often to ask for the channels' ingests again: a stream key reset on Twitch is picked up within this. */
const INGEST_REFRESH_MS = 30 * 60_000;
/** How soon to ask again when an ingest could not be read, or how to reach OBS could not be reported. */
const RETRY_MS = 60_000;

/** The room the runtime is given, and the releases it runs. */
export interface ObsRuntimeOptions {
  /** A directory of its own: binaries under `binaries/`, OBS's log and pidfile, its macOS home, and relays. */
  directory: string;
  /** The OBS release to run. */
  binary: ObsManifest;
  /** The moq CLI release the exposures are relayed by. */
  moq: MoqManifest;
  /** The MediaMTX release the programme and the exposures go through. */
  mediamtx: MediamtxManifest;
  /** Where the program MediaMTX listens, on loopback. */
  programPorts: ProgramPorts;
  /** The port obs-websocket serves on, on this machine. */
  websocketPort: number;
  /** The studio API, as the agent's device, for read sessions, the channels' ingests, and reporting control. */
  studio: Client;
}

export interface ObsStatus extends ProcessStatus {
  /** The version of OBS running, or being started. */
  version: string | null;
  /** Whether a binary is being downloaded and checked. */
  installing: boolean;
  /** The output being sent out, who drives its scenes, and the scene collection OBS runs for it. */
  output: string | null;
  control: Control | null;
  collection: string | null;
  /** Whether OBS is streaming the programme. */
  streaming: StreamingState;
  /** Whether OBS is recording the programme, while the output has a recorder. */
  recording: RecordingState | null;
  /** The program MediaMTX, and the channels and previews it sends to. */
  program: ProgramStatus | null;
  /** The exposures relayed for OBS to play. */
  inputs: InputsStatus;
  /** The programme's reports. */
  reports: ProgramMetricsStatus | null;
}

const STOPPED: ObsStatus = {
  ...PROCESS_STOPPED,
  version: null,
  installing: false,
  output: null,
  control: null,
  collection: null,
  streaming: null,
  recording: null,
  program: null,
  inputs: { reading: {} },
  reports: null
};

/** OBS's executable name, as `ps` reports it. */
const PROCESS_NAME = process.platform === 'win32' ? 'obs64' : 'OBS';

/** The only recorder kind there is: OBS recording the programme alongside streaming it. */
const OBS_RECORDER = 'obs';

/** A first start scans plugins, and macOS checks a new app: OBS may take a while to answer. */
const READY_TIMEOUT_MS = 60_000;

/** Where obs-websocket answers on this machine, and its password. */
export interface ObsWebsocket {
  url: string;
  password: string;
}

/** What the agent reports of how to drive OBS from outside (`organisations.outputs.control.report`). */
interface ControlReport {
  id: string;
  outputId: string;
  websocketPort: number;
  websocketPassword: string;
  sceneCollection: string;
  inputUrl: string;
}

/**
 * The `obs` key, fulfilled by an OBS of the agent's own: installed by the runtime, started with a configuration it
 * writes (obs-websocket on its port, with its password, and the scene collection of the output's control), and lived
 * and died with the agent. OBS streams whatever is on its programme to the program MediaMTX, which forwards, previews
 * and records it; the exposures OBS reads are relayed into the same MediaMTX (inputs.ts). What is on screen is not this
 * runtime's: the `show` key drives the scenes, or something outside the studio does, which reads how to reach OBS
 * from the studio API, as this reports it. OBS runs on Windows and macOS only (binaries/obs.ts).
 *
 * Stopping OBS is something it takes for a crash, so each launch clears that first (settings.ts).
 */
export class ObsRuntime {
  readonly status$ = new BehaviorSubject<ObsStatus>(STOPPED);
  /** The exposures OBS plays, relayed while it reads them: what the `show` key's sources read too. */
  readonly inputs: InputRelays;
  private readonly binaries: BinaryStore;
  private readonly process: AttachedProcess;
  private readonly program: ProgramMediamtx;
  private readonly metrics: ProgramMetrics;
  private readonly watching: Subscription[];
  private watchdog: StreamingWatchdog | undefined = undefined;
  /** The scene whatever drives OBS has on program: what the watchdog restores, and none to leave scenes alone. */
  private programScene: ProgramScene | undefined = undefined;
  private forwards: ObsSpec['forwards'] = [];
  private refresh: ReturnType<typeof setTimeout> | undefined = undefined;
  /** What was last reported of how to drive OBS, and when to try reporting again after a failure. */
  private reported: string | undefined = undefined;
  private reporting: ReturnType<typeof setTimeout> | undefined = undefined;

  constructor(private readonly options: ObsRuntimeOptions) {
    this.binaries = new BinaryStore({ directory: join(options.directory, 'binaries') });
    this.process = new AttachedProcess(options.directory, {
      name: PROCESS_NAME,
      probe: signal => listening(options.websocketPort, signal),
      readyTimeoutMs: READY_TIMEOUT_MS
    });
    this.program = new ProgramMediamtx(join(options.directory, 'program'), options.programPorts);
    this.inputs = new InputRelays({
      studio: options.studio,
      program: this.program,
      directory: join(options.directory, 'inputs')
    });
    this.metrics = new ProgramMetrics(this.program, () => this.watchdog?.reading$.value ?? null);
    this.watching = [
      this.process.status$.subscribe(status => this.update(status)),
      this.program.status$.subscribe(program => this.update({ program })),
      this.inputs.status$.subscribe(inputs => this.update({ inputs })),
      this.metrics.status$.subscribe(reports => this.update({ reports }))
    ];
  }

  /** Where vignette's OBS target keeps the files OBS loads for its sources. */
  get vignetteDirectory(): string {
    return join(this.options.directory, 'vignette');
  }

  /** Where obs-websocket answers on this machine, and its password. */
  async websocket(): Promise<ObsWebsocket> {
    const password = await websocketPassword(this.options.directory);
    return { url: `ws://127.0.0.1:${String(this.options.websocketPort)}`, password };
  }

  /** Restore `scene` to program whenever OBS comes back on its empty starting scene; with none, leave scenes alone. */
  driveProgram(scene: ProgramScene | undefined): void {
    this.programScene = scene;
  }

  /**
   * Installs OBS, moq and MediaMTX if need be; has the program MediaMTX running, forwarding to the spec's channels,
   * publishing to its previews, and relaying the exposures OBS reads; has OBS running with obs-websocket on, the
   * agent's profile, streaming to it, and the collection of the spec's control; then the watchdog keeping OBS
   * streaming (and recording, with a recorder), the programme's reports, and how to drive OBS reported. Resolves once
   * OBS answers.
   */
  async execute(spec: ObsSpec, signal: AbortSignal): Promise<void> {
    if (process.platform !== 'win32' && process.platform !== 'darwin') {
      throw new Error(`OBS agents run on Windows and macOS, not ${process.platform}`);
    }
    const { directory, websocketPort } = this.options;
    const { output } = spec;
    const collection = COLLECTIONS[output.control];
    this.update({ output: output.id, control: output.control, collection });
    const installed = await this.installed(obsBinary, this.options.binary, signal);
    this.update({ version: installed.version });
    const moq = await this.installed(moqBinary, this.options.moq, signal);
    const mediamtx = await this.installed(mediamtxBinary, this.options.mediamtx, signal);
    await this.program.ensure(mediamtx, moq.path, signal);
    await this.forward(spec.forwards);
    await this.program.setPreviews(spec.previews);
    await this.inputs.serve(output.organisationId, moq.path);
    const { password } = await this.websocket();
    const launch = obsLaunch(installed.path, directory, collection);
    await writeObsSettings(launch.config, websocketPort, password);
    await writeObsProfile(launch.config, spec.encoding, { server: this.program.server, key: PROGRAM_KEY }, collection);
    // Another collection is another launch: OBS is restarted into it.
    const key = `${installed.id}:${collection}`;
    await this.process.ensure(
      { key, binary: installed.path, args: launch.args, cwd: launch.cwd, env: launch.env },
      signal
    );
    const watchdog = this.watch(password);
    const recording = this.recordingTarget(spec.recording);
    watchdog.record(recording);
    const recorder = recording === undefined ? undefined : recorderSubject(recording.recorderId);
    this.metrics.apply({ program: spec.program.subjectId, recorder });
    void this.report({
      id: output.organisationId,
      outputId: output.id,
      websocketPort,
      websocketPassword: password,
      sceneCollection: collection,
      inputUrl: this.program.inputTemplate
    });
    for (const binary of [installed, moq, mediamtx]) await this.binaries.prune(binary, { spare: 1 });
  }

  /**
   * Forward the programme to the channels' ingests, asked for now and again every half hour. A channel whose ingest
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
    const delay = failed ? RETRY_MS : INGEST_REFRESH_MS;
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

  /**
   * Report how to drive OBS from outside, when it differs from what was last reported: tried again a minute on if the
   * studio API doesn't take it.
   */
  private async report(report: ControlReport): Promise<void> {
    clearTimeout(this.reporting);
    const text = JSON.stringify(report);
    if (text === this.reported) return;
    const { studio } = this.options;
    const result = await studio.organisations.outputs.control.report.v1(report).catch((error: Error) => error);
    if (result instanceof Error) {
      logger.warn('How to drive OBS could not be reported: {error}', { error: result });
      this.reporting = setTimeout(() => void this.report(report), RETRY_MS);
      return;
    }
    this.reported = text;
  }

  /** The watchdog keeping OBS streaming, made once with the password it connects with. */
  private watch(password: string): StreamingWatchdog {
    if (this.watchdog !== undefined) return this.watchdog;
    const url = `ws://127.0.0.1:${String(this.options.websocketPort)}`;
    const watchdog = new StreamingWatchdog(url, password, () => this.programScene?.());
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

  /** The key is absent: stop watching and relaying, and stop OBS, then the program MediaMTX. */
  async finalize(): Promise<void> {
    clearTimeout(this.refresh);
    clearTimeout(this.reporting);
    this.reported = undefined;
    this.metrics.stop();
    await this.watchdog?.stop();
    this.watchdog = undefined;
    await this.inputs.stop();
    await this.process.stop();
    await this.program.stop();
    this.update({ program: null, output: null, control: null, collection: null });
  }

  /** The agent is stopping, and OBS and the program MediaMTX go with it. */
  dispose(): void {
    clearTimeout(this.refresh);
    clearTimeout(this.reporting);
    this.metrics.stop();
    void this.watchdog?.stop();
    this.inputs.dispose();
    for (const subscription of this.watching) subscription.unsubscribe();
    this.process.dispose();
    this.program.dispose();
  }

  private update(changes: Partial<ObsStatus>): void {
    this.status$.next({ ...this.status$.value, ...changes });
  }
}

/** Logs a channel's ingest failing, for a promise's `catch`: the forward keeps the ingest it last had. */
function logIngestFailure(channelId: string) {
  return (error: Error): undefined => {
    logger.error('The ingest for channel {channelId} is unavailable: {error}', { channelId, error });
    return undefined;
  };
}
