import { setTimeout as delay } from 'node:timers/promises';
import { type ResultPromise, execa } from 'execa';
import { BehaviorSubject } from 'rxjs';
import {
  CaddyAdmin,
  type CaddyOptions,
  type CaddySpec,
  type CaddyStatus,
  STOPPED,
  describe,
  exclusive,
  findCaddy,
  pidfile,
  restartDelay,
  stopCaddy,
  writeBootConfig
} from './caddy.ts';

const STOP_GRACE_MS = 5_000;

/** The Caddy process this runtime started, and whether it has exited yet. */
interface Child {
  process: ResultPromise;
  exited: boolean;
}

/**
 * Caddy as the agent's own child: it lives and dies with the agent. Stopping the agent stops Caddy, and if the agent
 * exits, execa's `cleanup` takes Caddy with it. On the next start, converge hands the spec back and Caddy is started
 * afresh. Simple, at the cost of downtime whenever the agent restarts.
 *
 * Nothing runs when an agent is killed outright (SIGKILL, out of memory), so its Caddy is orphaned. The pid is
 * recorded in a pidfile for that case alone: the next agent stops the orphan before starting its own.
 *
 * Caddy is watched through its process: the moment it exits unexpectedly, it is started again after a backoff, and
 * the status says so.
 */
export class AttachedCaddyRuntime {
  readonly status$ = new BehaviorSubject<CaddyStatus>(STOPPED);
  private readonly admin: CaddyAdmin;
  private readonly serially = exclusive();
  private child: Child | undefined = undefined;
  /** What Caddy should be serving; `undefined` once removed. */
  private wanted: CaddySpec | undefined = undefined;
  private crashes = 0;
  private restart: ReturnType<typeof setTimeout> | undefined = undefined;
  private disposed = false;

  constructor(private readonly options: CaddyOptions) {
    this.admin = new CaddyAdmin(options.admin);
  }

  /** Starts Caddy if it isn't running, then has it serve `spec`. Resolves once it is serving. */
  execute(spec: CaddySpec, signal: AbortSignal): Promise<void> {
    this.wanted = spec;
    return this.serially(() => this.serve(spec, signal));
  }

  /** Stops Caddy, gracefully if it will go. */
  finalize(): Promise<void> {
    this.wanted = undefined;
    clearTimeout(this.restart);
    return this.serially(async () => {
      await this.halt();
      this.update({ ...STOPPED, restarts: this.status$.getValue().restarts });
    });
  }

  /** The agent is stopping, and Caddy goes with it. */
  dispose(): void {
    this.disposed = true;
    clearTimeout(this.restart);
    const child = this.child;
    this.child = undefined;
    child?.process.kill();
    this.status$.complete();
  }

  private async serve(spec: CaddySpec, signal: AbortSignal): Promise<void> {
    const child = this.child ?? (await this.spawn(signal));
    await this.admin.load(spec, signal);
    this.crashes = 0;
    this.update({ state: 'running', pid: child.process.pid ?? null, serving: spec });
  }

  private async spawn(signal: AbortSignal): Promise<Child> {
    this.update({ state: 'starting', pid: null, serving: null });
    // An agent that died hard (SIGKILL, out of memory) never got to stop its Caddy, so stop that one first. If
    // something else still answers on the admin address, refuse to start, rather than quietly drive a process this
    // runtime doesn't own while its own Caddy fails to bind.
    const stale = await findCaddy(this.options, this.admin);
    if (stale !== undefined) await stopCaddy(stale, this.admin);
    if (await this.admin.alive()) throw new Error(`Something else is answering on ${this.options.admin}`);
    const boot = await writeBootConfig(this.options);
    const args = ['run', '--config', boot, '--pidfile', pidfile(this.options)];
    // `reject: false`: an exit is reported through `exited`, never as an unhandled rejection.
    const subprocess = execa(this.options.binary, args, { cleanup: true, killDescendants: true, reject: false });
    const child: Child = { process: subprocess, exited: false };
    this.child = child;
    void subprocess.then(result => this.exited(child, result.exitCode, result.signal));
    try {
      await this.admin.ready(signal, () => child.exited);
      return child;
    } catch (error) {
      // Half started: don't leave it behind.
      await this.halt();
      throw error;
    }
  }

  /** Caddy exited. If nobody asked it to, start it again after a backoff. */
  private exited(child: Child, code: number | undefined, signal: string | undefined): void {
    child.exited = true;
    if (child !== this.child) return;
    this.child = undefined;
    const spec = this.wanted;
    if (spec === undefined || this.disposed) return;
    this.crashes++;
    const { restarts } = this.status$.getValue();
    const lastError = `exited unexpectedly (${signal ?? `code ${code}`})`;
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
      this.update({ state: 'crashed', lastError: describe(error) });
      this.crashes++;
      this.restart = setTimeout(() => this.revive(spec), restartDelay(this.crashes));
    });
  }

  /** Stops Caddy: asks it to shut down through its admin API, then kills it if it hasn't within the grace period. */
  private async halt(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    if (child === undefined || child.exited) return;
    await this.admin.stop();
    await Promise.race([child.process, delay(STOP_GRACE_MS)]);
    if (!child.exited) child.process.kill('SIGKILL');
    await child.process;
  }

  private update(change: Partial<CaddyStatus>): void {
    if (this.disposed) return;
    const current = this.status$.getValue();
    this.status$.next({ ...current, ...change });
  }
}
