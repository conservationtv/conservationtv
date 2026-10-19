import { spawn } from 'node:child_process';
import { open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { BehaviorSubject } from 'rxjs';
import {
  CaddyAdmin,
  type CaddyOptions,
  type CaddySpec,
  type CaddyStatus,
  STOPPED,
  alive,
  describe,
  exclusive,
  findCaddy,
  pidfile,
  restartDelay,
  stopCaddy,
  writeBootConfig
} from './caddy.ts';

const WATCH_INTERVAL_MS = 1_000;

/**
 * Caddy as a process of its own, outliving the agent. It runs detached, and records its pid in a pidfile. When the
 * agent stops, Caddy carries on serving: stopping isn't removing. When the agent starts again, it finds Caddy through
 * the pidfile, checks it really is the Caddy it left (a pid can be reused by an unrelated process), and adopts it
 * without a restart. Only removing the key, through `finalize`, stops Caddy.
 *
 * A process the agent didn't start can't be waited on, so Caddy is watched by checking every second that its pid is
 * still alive. If it has died, it is started again after a backoff, and the status says so.
 */
export class AdoptedCaddyRuntime {
  readonly status$ = new BehaviorSubject<CaddyStatus>(STOPPED);
  private readonly admin: CaddyAdmin;
  private readonly serially = exclusive();
  private readonly pidfile: string;
  private readonly log: string;
  private pid: number | undefined = undefined;
  /** What Caddy should be serving; `undefined` once removed. */
  private wanted: CaddySpec | undefined = undefined;
  private crashes = 0;
  private watching: ReturnType<typeof setInterval> | undefined = undefined;
  private restart: ReturnType<typeof setTimeout> | undefined = undefined;
  private disposed = false;

  constructor(private readonly options: CaddyOptions) {
    this.admin = new CaddyAdmin(options.admin);
    this.pidfile = pidfile(options);
    this.log = join(options.directory, 'caddy.log');
  }

  /** Adopts the Caddy left running, or starts one, then has it serve `spec`. Resolves once it is serving. */
  execute(spec: CaddySpec, signal: AbortSignal): Promise<void> {
    this.wanted = spec;
    return this.serially(() => this.serve(spec, signal));
  }

  /** Stops Caddy, gracefully if it will go, including one left running by an earlier agent. */
  finalize(): Promise<void> {
    this.wanted = undefined;
    clearTimeout(this.restart);
    clearInterval(this.watching);
    return this.serially(async () => {
      const pid = this.pid ?? (await findCaddy(this.options, this.admin));
      this.pid = undefined;
      if (pid !== undefined) await stopCaddy(pid, this.admin);
      await rm(this.pidfile, { force: true });
      this.update({ ...STOPPED, restarts: this.status$.getValue().restarts });
    });
  }

  /** The agent is stopping. Caddy is left running for the next agent to adopt; only the watching stops. */
  dispose(): void {
    this.disposed = true;
    clearTimeout(this.restart);
    clearInterval(this.watching);
    this.status$.complete();
  }

  private async serve(spec: CaddySpec, signal: AbortSignal): Promise<void> {
    const pid = await this.running(signal);
    // Loading the same config again is a no-op for Caddy, so an adopted Caddy already serving `spec` is undisturbed.
    await this.admin.load(spec, signal);
    this.crashes = 0;
    this.update({ state: 'running', pid, serving: spec });
  }

  /** The pid of a Caddy that is up: the one being watched, one left running by an earlier agent, or a new one. */
  private async running(signal: AbortSignal): Promise<number> {
    if (this.pid !== undefined && alive(this.pid)) return this.pid;
    const pid = (await findCaddy(this.options, this.admin)) ?? (await this.spawn(signal));
    this.pid = pid;
    this.watch(pid);
    return pid;
  }

  private async spawn(signal: AbortSignal): Promise<number> {
    this.update({ state: 'starting', pid: null, serving: null });
    const boot = await writeBootConfig(this.options);
    const args = ['run', '--config', boot, '--pidfile', this.pidfile];
    // Plain `spawn`, not execa: execa is built around owning its child (piping, cleaning up, waiting), which is
    // exactly what a detached Caddy lets go of. Caddy writes its log straight to the file through a descriptor of its
    // own; writing through pipes to the agent would keep the agent alive, and break Caddy's output once it exits.
    const log = await open(this.log, 'a');
    const subprocess = spawn(this.options.binary, args, { detached: true, stdio: ['ignore', log.fd, log.fd] });
    subprocess.unref();
    // Listen before awaiting anything else: `spawn` or `error` fires on the next tick.
    const started = new Promise<Error | undefined>(resolve => {
      subprocess.once('spawn', () => resolve(undefined));
      subprocess.once('error', resolve);
    });
    await log.close();
    const failed = await started;
    if (failed !== undefined) throw failed;
    const pid = subprocess.pid;
    if (pid === undefined) throw new Error('Caddy could not be started');
    try {
      await this.admin.ready(signal, () => !alive(pid));
      return pid;
    } catch (error) {
      // Half started: don't leave it behind.
      await stopCaddy(pid, this.admin);
      throw error;
    }
  }

  /** Checks every second that Caddy is still alive; if it has died, starts it again after a backoff. */
  private watch(pid: number): void {
    clearInterval(this.watching);
    this.watching = setInterval(() => {
      if (alive(pid) || this.pid !== pid) return;
      clearInterval(this.watching);
      this.pid = undefined;
      this.died(`process ${pid} died`);
    }, WATCH_INTERVAL_MS);
    this.watching.unref();
  }

  private died(lastError: string): void {
    const spec = this.wanted;
    if (spec === undefined || this.disposed) return;
    this.crashes++;
    const { restarts } = this.status$.getValue();
    this.update({ state: 'crashed', pid: null, serving: null, restarts: restarts + 1, lastError });
    this.restart = setTimeout(() => this.revive(spec), restartDelay(this.crashes));
  }

  private revive(spec: CaddySpec): void {
    const restarting = this.serially(async () => {
      if (this.wanted !== spec || this.disposed) return;
      await this.serve(spec, AbortSignal.timeout(30_000));
    });
    restarting.catch((error: Error) => {
      if (this.wanted !== spec || this.disposed) return;
      this.crashes++;
      this.update({ state: 'crashed', lastError: describe(error) });
      this.restart = setTimeout(() => this.revive(spec), restartDelay(this.crashes));
    });
  }

  private update(change: Partial<CaddyStatus>): void {
    if (this.disposed) return;
    const current = this.status$.getValue();
    this.status$.next({ ...current, ...change });
  }
}
