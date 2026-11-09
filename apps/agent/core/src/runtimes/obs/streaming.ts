import { getLogger } from '@logtape/logtape';
import { OBSWebSocket } from 'obs-websocket-js';
import { BehaviorSubject } from 'rxjs';
import { BASE_SCENE } from './settings.ts';

// Keeps OBS streaming the show. `--startstreaming` starts it with each launch (settings.ts), but OBS can stop on its
// own while it runs: it gives up reconnecting to the program MediaMTX, say. So every few seconds the watchdog asks
// obs-websocket whether the stream output is active, and starts it if it isn't and isn't reconnecting either.
//
// It also takes OBS off the collection's empty starting scene. Vignette's target puts the show's active scene on
// program only when that scene changes, so an OBS that comes back on the empty scene (a fresh collection, or a crash
// before OBS saved the switch) would otherwise stay there, streaming black, until the show next changes scene. The
// watchdog moves it to the show's active scene, and leaves any other scene alone: an operator may have chosen it.
//
// OBS crashing is the process supervisor's to handle, not this: the watchdog just reconnects when OBS answers again.

const logger = getLogger(['agent', 'obs', 'streaming']);

/** How often to check: short, as an OBS back from a crash streams black until the scene is put right. */
const INTERVAL_MS = 5000;

/** Whether OBS is streaming, as last checked: null before it first answers. */
export type StreamingState = 'streaming' | 'reconnecting' | 'starting' | null;

/** The OBS scene the show is on now, if the show has said: what the empty starting scene is replaced with. */
export type ProgramScene = () => string | undefined;

/** Checks OBS at `url` every few seconds, starting its stream whenever it is stopped and taking it off the empty scene. */
export class StreamingWatchdog {
  readonly state$ = new BehaviorSubject<StreamingState>(null);
  private readonly obs = new OBSWebSocket();
  private connected = false;
  private timer: ReturnType<typeof setInterval> | undefined = undefined;
  private checking = false;

  constructor(
    private readonly url: string,
    private readonly password: string,
    private readonly programScene: ProgramScene
  ) {
    this.obs.on('ConnectionClosed', () => {
      this.connected = false;
      this.state$.next(null);
    });
  }

  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => void this.check(), INTERVAL_MS);
    void this.check();
  }

  /** One check: connect if need be, start the stream if it is stopped, then put the show's scene on program. */
  private async check(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      if (!this.connected) {
        await this.obs.connect(this.url, this.password);
        this.connected = true;
      }
      await this.keepStreaming();
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

  /** Starts the stream if it is neither active nor reconnecting. */
  private async keepStreaming(): Promise<void> {
    const status = await this.obs.call('GetStreamStatus');
    if (status.outputActive) {
      this.state$.next(status.outputReconnecting ? 'reconnecting' : 'streaming');
      return;
    }
    logger.warn('OBS is not streaming: starting it');
    this.state$.next('starting');
    await this.obs.call('StartStream');
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    if (this.connected) await this.obs.disconnect().catch(() => undefined);
    this.connected = false;
    this.state$.next(null);
  }
}
