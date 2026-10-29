import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { type ResultPromise, execa } from 'execa';
import psList from 'ps-list';
import { BehaviorSubject } from 'rxjs';
import treeKill from 'tree-kill';

// A process that is the agent's own child, living and dying with it: started with its log on a file in a directory
// of its own, watched through its exit, and stopped when the agent stops. Its pid is recorded only so that the next
// agent can stop one orphaned by an agent killed outright.

/** How a runtime's process is told apart from any other, probed, and asked to stop. */
export interface ProcessDefinition {
  /** What `ps` calls it: its executable's name. A pid reused by an unrelated process is told apart by it. */
  name: string;
  /** Whether the process is up and answering, such as on its admin API. `signal` aborts after a second. */
  probe(signal: AbortSignal): Promise<boolean>;
  /** Asks the process to stop gracefully; SIGTERM if not given. Killing it if it doesn't go is handled. */
  stop?(pid: number): Promise<void>;
}

/** What is to run. */
export interface Run {
  /**
   * What the process is started for: an install's id, or that and the config's revision for a process that can't
   * reload. The process running is kept for the same key, and replaced for another.
   */
  key: string;
  binary: string;
  args: string[];
  /** The directory to run in; the process's own if not given. */
  cwd?: string;
  /** Run once the process answers, whether already running, started or restarted, and before `ensure` resolves. */
  configure?(signal: AbortSignal): Promise<void>;
}

export interface ProcessStatus {
  state: 'stopped' | 'starting' | 'running' | 'crashed';
  pid: number | null;
  /** How many times it has been started again after it died. */
  restarts: number;
  /** Why it last died, or could not be started. */
  lastError: string | null;
}

export const STOPPED: ProcessStatus = { state: 'stopped', pid: null, restarts: 0, lastError: null };

const PROBE_TIMEOUT_MS = 1_000;
const READY_TIMEOUT_MS = 10_000;
const STOP_GRACE_MS = 5_000;
const RESTART_BASE_MS = 1_000;
const RESTART_MAX_MS = 30_000;
const REVIVE_TIMEOUT_MS = 30_000;

/** How long to wait before starting a process again after it has died `crashes` times in a row. */
export function restartDelay(crashes: number): number {
  return Math.min(RESTART_BASE_MS * 2 ** (crashes - 1), RESTART_MAX_MS);
}

/** Whether a process exists at `pid`. Signal 0 checks without sending anything; EPERM means it exists but isn't ours. */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

/** Whether the process answers its probe, a probe that throws counting as no. */
export function answering(definition: ProcessDefinition): Promise<boolean> {
  return definition.probe(AbortSignal.timeout(PROBE_TIMEOUT_MS)).catch(() => false);
}

/** Waits until the process answers, giving up if `signal` aborts, `gone()` says it died, or it takes too long. */
export async function ready(definition: ProcessDefinition, signal: AbortSignal, gone: () => boolean): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (!(await answering(definition))) {
    signal.throwIfAborted();
    if (gone()) throw new Error(`${definition.name} exited before it was ready`);
    if (Date.now() > deadline) throw new Error(`${definition.name} did not answer in time`);
    await delay(100, undefined, { signal });
  }
}

/**
 * The process recorded in `pidfile`, if it is still alive, really is the one defined (a pid can be reused by an
 * unrelated process), and answers its probe.
 */
export async function findProcess(pidfile: string, definition: ProcessDefinition): Promise<number | undefined> {
  const recorded = await readFile(pidfile, 'utf8').catch(() => undefined);
  const pid = Number(recorded);
  if (!Number.isInteger(pid) || pid <= 0 || !alive(pid)) return undefined;
  const processes = await psList();
  const found = processes.find(each => each.pid === pid);
  if (found === undefined || !found.name.toLowerCase().startsWith(definition.name.toLowerCase())) return undefined;
  if (!(await answering(definition))) return undefined;
  return pid;
}

/**
 * Stops the process at `pid`: asks it to stop as defined, or with SIGTERM, then kills it and anything it started if it
 * hasn't gone within the grace period.
 */
export async function stopProcess(pid: number, definition: ProcessDefinition): Promise<void> {
  if (definition.stop !== undefined) await definition.stop(pid).catch(() => undefined);
  else {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      return;
    }
  }
  const deadline = Date.now() + STOP_GRACE_MS;
  while (alive(pid) && Date.now() < deadline) await delay(100);
  if (alive(pid)) await new Promise<void>(resolve => treeKill(pid, 'SIGKILL', () => resolve()));
}

/** Runs tasks one at a time, so a restart after a crash never races an `ensure` or a `stop`. */
export function exclusive(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return task => {
    const result = tail.then(task);
    tail = result.catch(() => undefined);
    return result;
  };
}

export function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** The process this agent started, what it was started for, and whether it has exited yet. */
interface Child {
  process: ResultPromise;
  pid: number;
  key: string;
  exited: boolean;
}

/**
 * A process that is the agent's own child. `ensure` has a process from a `Run`'s key up and answering: the one
 * running, if it was started for the same key, or a new one in its place. `stop` and `dispose` both stop it, and if
 * the agent exits, execa's `cleanup` takes it along, so the next agent starts afresh.
 *
 * Nothing runs when an agent is killed outright (SIGKILL, out of memory), so its process is orphaned. The pid is
 * recorded in a pidfile for that case alone: the next agent stops the orphan before starting its own, and refuses to
 * start while anything else answers in its place.
 *
 * The process is watched through its exit: the moment it exits unexpectedly, it is started again after a backoff,
 * and the status says so.
 */
export class AttachedProcess {
  readonly status$ = new BehaviorSubject<ProcessStatus>(STOPPED);
  /** Where the process's pid is kept, for an orphan's sake; its log is written beside it. */
  readonly pidfile: string;
  private readonly log: string;
  private readonly serially = exclusive();
  private child: Child | undefined = undefined;
  /** What should be running; `undefined` once stopped. */
  private wanted: Run | undefined = undefined;
  private crashes = 0;
  private restart: ReturnType<typeof setTimeout> | undefined = undefined;
  private disposed = false;

  constructor(
    private readonly directory: string,
    private readonly definition: ProcessDefinition
  ) {
    this.pidfile = join(directory, `${definition.name}.pid`);
    this.log = join(directory, `${definition.name}.log`);
  }

  /** Has a process from `run`'s key up, answering and configured. Resolves with its pid. */
  ensure(run: Run, signal: AbortSignal): Promise<number> {
    this.wanted = run;
    return this.serially(() => this.serve(run, signal));
  }

  /** Stops the process, including one orphaned by an agent killed outright. */
  stop(): Promise<void> {
    this.wanted = undefined;
    clearTimeout(this.restart);
    return this.serially(async () => {
      await this.halt();
      const orphan = await findProcess(this.pidfile, this.definition);
      if (orphan !== undefined) await stopProcess(orphan, this.definition);
      await rm(this.pidfile, { force: true });
      this.update({ state: 'stopped', pid: null, lastError: null });
    });
  }

  /** The agent is stopping, and the process goes with it. */
  dispose(): void {
    this.disposed = true;
    clearTimeout(this.restart);
    const child = this.child;
    this.child = undefined;
    child?.process.kill();
    this.status$.complete();
  }

  private async serve(run: Run, signal: AbortSignal): Promise<number> {
    const current = this.child;
    const pid = current !== undefined && current.key === run.key ? current.pid : await this.replace(run, signal);
    await run.configure?.(signal);
    this.crashes = 0;
    this.update({ state: 'running', pid, lastError: null });
    return pid;
  }

  /** Stops the process running, if any, so the new one can take its ports, then starts one from `run`. */
  private async replace(run: Run, signal: AbortSignal): Promise<number> {
    await this.halt();
    return this.spawn(run, signal);
  }

  private async spawn(run: Run, signal: AbortSignal): Promise<number> {
    this.update({ state: 'starting', pid: null });
    // An agent that died hard never got to stop its process, so stop that one first. If something else still
    // answers, refuse to start, rather than quietly drive a process this agent doesn't own while its own fails to bind.
    const stale = await findProcess(this.pidfile, this.definition);
    if (stale !== undefined) await stopProcess(stale, this.definition);
    if (await answering(this.definition))
      throw new Error(`Something else is answering in place of ${this.definition.name}`);
    await mkdir(this.directory, { recursive: true });
    const log = { file: this.log, append: true };
    // `reject: false`: an exit is reported through `exited`, never as an unhandled rejection.
    const subprocess = execa(run.binary, run.args, {
      cwd: run.cwd ?? this.directory,
      stdin: 'ignore',
      stdout: log,
      stderr: log,
      cleanup: true,
      killDescendants: true,
      forceKillAfterDelay: STOP_GRACE_MS,
      reject: false
    });
    const pid = subprocess.pid;
    if (pid === undefined) {
      const result = await subprocess;
      throw new Error(`${this.definition.name} could not be started: ${result.message ?? 'no pid'}`);
    }
    const child: Child = { process: subprocess, pid, key: run.key, exited: false };
    this.child = child;
    void subprocess.then(result => this.exited(child, result.exitCode, result.signal));
    await writeFile(this.pidfile, String(pid));
    try {
      await ready(this.definition, signal, () => child.exited);
      return pid;
    } catch (error) {
      // Half started: don't leave it behind.
      await this.halt();
      throw error;
    }
  }

  /** The process exited. If nobody asked it to, start it again after a backoff. */
  private exited(child: Child, code: number | undefined, signal: string | undefined): void {
    child.exited = true;
    if (child !== this.child) return;
    this.child = undefined;
    const run = this.wanted;
    if (run === undefined || this.disposed) return;
    this.crashes++;
    const { restarts } = this.status$.getValue();
    const lastError = `exited unexpectedly (${signal ?? `code ${code}`})`;
    this.update({ state: 'crashed', pid: null, restarts: restarts + 1, lastError });
    this.restart = setTimeout(() => this.revive(run), restartDelay(this.crashes));
  }

  private revive(run: Run): void {
    const restarting = this.serially(async () => {
      if (this.wanted !== run || this.disposed) return;
      await this.serve(run, AbortSignal.timeout(REVIVE_TIMEOUT_MS));
    });
    restarting.catch((error: Error) => {
      if (this.wanted !== run || this.disposed) return;
      this.crashes++;
      this.update({ state: 'crashed', lastError: describe(error) });
      this.restart = setTimeout(() => this.revive(run), restartDelay(this.crashes));
    });
  }

  /**
   * Stops the process this agent started: asks it to stop as defined, or with SIGTERM, then kills it and anything it
   * started if it hasn't gone within the grace period.
   */
  private async halt(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    if (child === undefined || child.exited) return;
    if (this.definition.stop !== undefined) await this.definition.stop(child.pid).catch(() => undefined);
    else child.process.kill('SIGTERM');
    await Promise.race([child.process, delay(STOP_GRACE_MS)]);
    if (!child.exited) child.process.kill('SIGKILL');
    await child.process;
  }

  private update(change: Partial<ProcessStatus>): void {
    if (this.disposed) return;
    const current = this.status$.getValue();
    this.status$.next({ ...current, ...change });
  }
}
