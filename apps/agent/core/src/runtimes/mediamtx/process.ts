import { type ChildProcess, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { BehaviorSubject } from 'rxjs';

// MediaMTX as a child of the agent: started, waited on until it is up, stopped gracefully, and started again after a
// backoff if it dies. It stops with the agent.

export interface ProcessStatus {
  state: 'stopped' | 'starting' | 'running' | 'crashed';
  pid: number | null;
  /** How many times it has been started again after it died. */
  restarts: number;
  /** Why it last died or failed to start. */
  lastError: string | null;
}

/** What MediaMTX is started with. */
export interface Launch {
  /** The executable. */
  binary: string;
  /** Its mediamtx.yml. */
  config: string;
}

export interface MediamtxProcessOptions {
  /** Where MediaMTX runs, and writes what it generates (such as its MoQ certificate). Never the shared install. */
  directory: string;
  /** Whether MediaMTX is up. */
  alive: () => Promise<boolean>;
}

const STOPPED: ProcessStatus = { state: 'stopped', pid: null, restarts: 0, lastError: null };

const READY_TIMEOUT_MS = 10_000;
const STOP_GRACE_MS = 5_000;
const RESTART_BASE_MS = 1_000;
const RESTART_MAX_MS = 30_000;

/** How long to wait before starting MediaMTX again after it has died `crashes` times in a row. */
function restartDelay(crashes: number): number {
  return Math.min(RESTART_BASE_MS * 2 ** (crashes - 1), RESTART_MAX_MS);
}

function exited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/** One MediaMTX process, kept running from what it was last started with until it is stopped. */
export class MediamtxProcess {
  readonly status$ = new BehaviorSubject<ProcessStatus>(STOPPED);
  /** What it should be running from; `undefined` once stopped. */
  private launch: Launch | undefined = undefined;
  private child: ChildProcess | undefined = undefined;
  private crashes = 0;
  private restart: ReturnType<typeof setTimeout> | undefined = undefined;

  constructor(private readonly options: MediamtxProcessOptions) {}

  /** Whether it is running from `binary`. */
  runs(binary: string): boolean {
    return this.child !== undefined && this.launch?.binary === binary;
  }

  /** Replaces whatever runs now with MediaMTX started from `launch`. Resolves once it is up. */
  async start(launch: Launch, signal: AbortSignal): Promise<void> {
    await this.halt();
    this.launch = launch;
    this.crashes = 0;
    await this.spawn(launch, signal);
  }

  /** Stops it, and keeps it stopped. */
  async stop(): Promise<void> {
    this.launch = undefined;
    await this.halt();
  }

  /** The agent is stopping, and MediaMTX, its child, stops with it. */
  dispose(): void {
    this.launch = undefined;
    clearTimeout(this.restart);
    const child = this.child;
    this.child = undefined;
    child?.kill();
    this.status$.complete();
  }

  private async spawn(launch: Launch, signal: AbortSignal): Promise<void> {
    this.update({ state: 'starting', pid: null });
    // Its structured log goes to the agent's.
    const child = spawn(launch.binary, [launch.config], {
      cwd: this.options.directory,
      stdio: ['ignore', 'inherit', 'inherit']
    });
    const started = new Promise<Error | undefined>(resolve => {
      child.once('spawn', () => resolve(undefined));
      child.once('error', resolve);
    });
    const failed = await started;
    if (failed !== undefined) throw failed;
    if (this.launch !== launch) {
      // Stopped or replaced while it spawned: a restart after a crash, overtaken.
      child.kill();
      throw new Error('MediaMTX was stopped while it started');
    }
    this.child = child;
    child.once('exit', (code, exitSignal) => this.died(child, `exited with ${exitSignal ?? code}`));
    try {
      await this.ready(child, signal);
    } catch (error) {
      // Half started: don't leave it behind.
      await this.halt();
      throw error;
    }
    this.update({ state: 'running', pid: child.pid ?? null });
  }

  /** Waits until it is up, giving up if `signal` aborts, it dies, or it takes too long. */
  private async ready(child: ChildProcess, signal: AbortSignal): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (!(await this.options.alive())) {
      signal.throwIfAborted();
      if (exited(child)) throw new Error('MediaMTX exited before it was ready');
      if (Date.now() > deadline) throw new Error('MediaMTX was not up in time');
      await delay(100, undefined, { signal });
    }
  }

  /** Stops the process if there is one: asks it to stop, then kills it if it hasn't within the grace period. */
  private async halt(): Promise<void> {
    clearTimeout(this.restart);
    const child = this.child;
    this.child = undefined;
    if (child === undefined || exited(child)) return;
    const gone = new Promise(resolve => child.once('exit', resolve));
    child.kill();
    const timeout = delay(STOP_GRACE_MS).then(() => 'timeout');
    if ((await Promise.race([gone, timeout])) === 'timeout') child.kill('SIGKILL');
    await gone;
    this.update({ state: 'stopped', pid: null });
  }

  /** It died without being asked to: start it again after a backoff. */
  private died(child: ChildProcess, lastError: string): void {
    if (this.child !== child) return;
    this.child = undefined;
    const { restarts } = this.status$.getValue();
    this.update({ state: 'crashed', pid: null, restarts: restarts + 1, lastError });
    this.retry();
  }

  private retry(): void {
    const launch = this.launch;
    if (launch === undefined || this.status$.closed) return;
    this.crashes++;
    this.restart = setTimeout(() => {
      this.spawn(launch, AbortSignal.timeout(READY_TIMEOUT_MS * 3)).then(
        () => (this.crashes = 0),
        (error: Error) => {
          // Superseded by a `start` or `stop` meanwhile, which own what happens next.
          if (this.launch !== launch || this.child !== undefined) return;
          this.update({ state: 'crashed', lastError: error.message });
          this.retry();
        }
      );
    }, restartDelay(this.crashes));
  }

  private update(change: Partial<ProcessStatus>): void {
    if (this.status$.closed) return;
    this.status$.next({ ...this.status$.getValue(), ...change });
  }
}
