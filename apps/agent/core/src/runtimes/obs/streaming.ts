import { getLogger } from '@logtape/logtape';
import { OBSWebSocket } from 'obs-websocket-js';
import { BehaviorSubject } from 'rxjs';

// Keeps OBS streaming. `--startstreaming` starts it with each launch (settings.ts), but OBS can stop on its own while it
// runs: it gives up reconnecting to the program MediaMTX, say. So every so often the watchdog asks obs-websocket
// whether the stream output is active, and starts it if it isn't and isn't reconnecting either. OBS crashing is the
// process supervisor's to handle, not this: the watchdog just reconnects when OBS answers again.

const logger = getLogger(['agent', 'obs', 'streaming']);

/** How often to check. */
const INTERVAL_MS = 15_000;

/** Whether OBS is streaming, as last checked: null before it first answers. */
export type StreamingState = 'streaming' | 'reconnecting' | 'starting' | null;

/** Checks OBS's stream output at `url` every 15 seconds, starting it whenever it is stopped. */
export class StreamingWatchdog {
  readonly state$ = new BehaviorSubject<StreamingState>(null);
  private readonly obs = new OBSWebSocket();
  private connected = false;
  private timer: ReturnType<typeof setInterval> | undefined = undefined;
  private checking = false;

  constructor(
    private readonly url: string,
    private readonly password: string
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

  /** One check: connect if need be, then start the stream if it is neither active nor reconnecting. */
  private async check(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      if (!this.connected) {
        await this.obs.connect(this.url, this.password);
        this.connected = true;
      }
      const status = await this.obs.call('GetStreamStatus');
      if (status.outputActive) {
        this.state$.next(status.outputReconnecting ? 'reconnecting' : 'streaming');
        return;
      }
      logger.warn('OBS is not streaming: starting it');
      this.state$.next('starting');
      await this.obs.call('StartStream');
    } catch (error) {
      // OBS is starting, or gone: the next check tries again.
      logger.debug('Could not check OBS streaming: {error}', { error });
    } finally {
      this.checking = false;
    }
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    if (this.connected) await this.obs.disconnect().catch(() => undefined);
    this.connected = false;
    this.state$.next(null);
  }
}
