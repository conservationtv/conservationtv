import { mkdir } from 'node:fs/promises';
import { getLogger } from '@logtape/logtape';
import { OBSWebSocket, type OBSResponseTypes } from 'obs-websocket-js';
import { BehaviorSubject } from 'rxjs';
import { BASE_SCENE } from './settings.ts';

// Keeps OBS streaming the show. `--startstreaming` starts it with each launch (settings.ts), but OBS can stop on its
// own while it runs: it gives up reconnecting to the program MediaMTX, say. So every few seconds the watchdog asks
// obs-websocket whether the stream output is active, and starts it if it isn't and isn't reconnecting either.
//
// With a recorder, it keeps OBS recording the same way: into the recorder's directory, started whenever it isn't
// recording, as after OBS restarts; and stopped once the recorder goes, or to start again in another's directory.
//
// It also takes OBS off the collection's empty starting scene. Vignette's target puts the show's active scene on
// program only when that scene changes, so an OBS that comes back on the empty scene (a fresh collection, or a crash
// before OBS saved the switch) would otherwise stay there, streaming black, until the show next changes scene. The
// watchdog moves it to the show's active scene, and leaves any other scene alone: an operator may have chosen it.
//
// Each check's answers (`GetStats`, `GetStreamStatus`, `GetRecordStatus`) are kept as the latest reading, which the
// program's reports and the runtime's status are made from (program-metrics.ts).
//
// OBS crashing is the process supervisor's to handle, not this: the watchdog just reconnects when OBS answers again.

const logger = getLogger(['agent', 'obs', 'streaming']);

/** How often to check: short, as an OBS back from a crash streams black until the scene is put right. */
const INTERVAL_MS = 5000;

/** Whether OBS is streaming, as last checked: null before it first answers. */
export type StreamingState = 'streaming' | 'reconnecting' | 'starting' | null;

/** Whether OBS is recording for the recorder, as last checked. */
export type RecordingState = 'recording' | 'starting' | 'stopping';

/** The OBS scene the show is on now, if the show has said: what the empty starting scene is replaced with. */
export type ProgramScene = () => string | undefined;

/** What OBS records, for a recorder: into a directory of the recorder's own. */
export interface RecordingTarget {
  recorderId: string;
  directory: string;
}

/** What one check read of OBS, at a time: its stats, its stream's status, and its recording's with a recorder. */
export interface ObsReading {
  at: number;
  stats: OBSResponseTypes['GetStats'];
  stream: OBSResponseTypes['GetStreamStatus'];
  record: OBSResponseTypes['GetRecordStatus'] | undefined;
}

/** Checks OBS at `url` every few seconds, starting its stream whenever it is stopped and taking it off the empty scene. */
export class StreamingWatchdog {
  readonly state$ = new BehaviorSubject<StreamingState>(null);
  /** Whether OBS records for the recorder, while there is one. */
  readonly recording$ = new BehaviorSubject<RecordingState | null>(null);
  /** The latest check's reading, or null while OBS doesn't answer. */
  readonly reading$ = new BehaviorSubject<ObsReading | null>(null);
  private readonly obs = new OBSWebSocket();
  private connected = false;
  private timer: ReturnType<typeof setInterval> | undefined = undefined;
  private checking = false;
  private recording: RecordingTarget | undefined = undefined;
  /** Whether a recording the watchdog was keeping going is to be stopped, its recorder gone. */
  private stopRecording = false;

  constructor(
    private readonly url: string,
    private readonly password: string,
    private readonly programScene: ProgramScene
  ) {
    this.obs.on('ConnectionClosed', () => {
      this.connected = false;
      this.state$.next(null);
      this.reading$.next(null);
    });
  }

  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => void this.check(), INTERVAL_MS);
    void this.check();
  }

  /** Keep OBS recording for `target` from the next check on, or with none, stop the recording kept so far. */
  record(target: RecordingTarget | undefined): void {
    if (target === undefined && this.recording !== undefined) this.stopRecording = true;
    if (target !== undefined) this.stopRecording = false;
    this.recording = target;
    if (target === undefined) this.recording$.next(null);
  }

  /**
   * One check: connect if need be, start the stream if it is stopped, keep the recording as the recorder says, keep
   * what was read, then put the show's scene on program.
   */
  private async check(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      if (!this.connected) {
        await this.obs.connect(this.url, this.password);
        this.connected = true;
      }
      const stream = await this.keepStreaming();
      // A recording that can't be kept (a full disk, say) is no reason to stop reading OBS or restoring its scene.
      const record = await this.keepRecording().catch(logRecordingFailure);
      const stats = await this.obs.call('GetStats');
      this.reading$.next({ at: Date.now(), stats, stream, record });
      await this.restoreProgram();
    } catch (error) {
      // OBS is starting, or gone, or the show's scene isn't made yet: the next check tries again.
      logger.debug('Could not check OBS: {error}', { error });
    } finally {
      this.checking = false;
    }
  }

  /** Moves program from the empty starting scene to the show's, once the show has one. */
  private async restoreProgram(): Promise<void> {
    const scene = this.programScene();
    if (scene === undefined) return;
    const program = await this.obs.call('GetCurrentProgramScene');
    if (program.currentProgramSceneName !== BASE_SCENE) return;
    logger.warn('OBS is on its empty starting scene: putting {scene} on program', { scene });
    await this.obs.call('SetCurrentProgramScene', { sceneName: scene });
  }

  /** Starts the stream if it is neither active nor reconnecting. The stream's status, as read before. */
  private async keepStreaming(): Promise<OBSResponseTypes['GetStreamStatus']> {
    const status = await this.obs.call('GetStreamStatus');
    if (status.outputActive) {
      this.state$.next(status.outputReconnecting ? 'reconnecting' : 'streaming');
      return status;
    }
    logger.warn('OBS is not streaming: starting it');
    this.state$.next('starting');
    await this.obs.call('StartStream');
    return status;
  }

  /**
   * With a recorder, starts recording into its directory if OBS isn't recording, or is recording elsewhere (stopped
   * first, and started on the next check). Without one, stops the recording kept for the recorder that went. The
   * recording's status, as read before, while there is a recorder.
   */
  private async keepRecording(): Promise<OBSResponseTypes['GetRecordStatus'] | undefined> {
    const target = this.recording;
    if (target === undefined) {
      if (this.stopRecording) await this.stopKept();
      return undefined;
    }
    const status = await this.obs.call('GetRecordStatus');
    const { recordDirectory } = await this.obs.call('GetRecordDirectory');
    if (status.outputActive && recordDirectory === target.directory) {
      this.recording$.next('recording');
      return status;
    }
    if (status.outputActive) {
      logger.warn('OBS is recording into {recordDirectory}: stopping it, to record for {recorderId}', {
        recordDirectory,
        recorderId: target.recorderId
      });
      this.recording$.next('stopping');
      await this.obs.call('StopRecord');
      return status;
    }
    logger.warn('OBS is not recording for {recorderId}: starting it', { recorderId: target.recorderId });
    this.recording$.next('starting');
    await mkdir(target.directory, { recursive: true });
    await this.obs.call('SetRecordDirectory', { recordDirectory: target.directory });
    await this.obs.call('StartRecord');
    return status;
  }

  /** Stops the recording the watchdog kept going, if OBS is still making it. */
  private async stopKept(): Promise<void> {
    const status = await this.obs.call('GetRecordStatus');
    if (status.outputActive) {
      logger.info('The recorder is gone: stopping the recording');
      await this.obs.call('StopRecord');
    }
    this.stopRecording = false;
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    if (this.connected) await this.obs.disconnect().catch(() => undefined);
    this.connected = false;
    this.state$.next(null);
    this.recording$.next(null);
    this.reading$.next(null);
  }
}

/** Logs the recording failing to be kept, for a promise's `catch`: the next check tries again. */
function logRecordingFailure(error: Error): undefined {
  logger.error('Could not keep OBS recording: {error}', { error });
  return undefined;
}
