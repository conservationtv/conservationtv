import { spawn } from 'node:child_process';
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import psList from 'ps-list';
import { BehaviorSubject } from 'rxjs';
import treeKill from 'tree-kill';

// A process of its own, outliving the agent: started detached, with its log on a file, and found again through a
// pidfile in a directory of its own. What it was started for is recorded beside the pid as a key, so the next agent
// knows whether what it finds running is what the spec now asks for.

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
   * reload. A process found running is adopted if it was started for the same key, and replaced otherwise.
   */
  key: string;
  binary: string;
  args: string[];
  /** The directory to run in; the process's own if not given. */
  cwd?: string;
  /** Run once the process answers, whether started, adopted or restarted, and before `ensure` resolves. */
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
const WATCH_INTERVAL_MS = 1_000;
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

/** The process being watched, and what it was started for. */
interface Current {
  pid: number;
  key: string;
}

/**
 * A process that outlives the agent, adopted when found and replaced when it isn't what is wanted. `ensure` has a
 * process from a `Run`'s key up and answering: the one being watched, one left running by an earlier agent whose
 * recorded key is the same, or a new one, anything else found being stopped first. When the agent stops, the process
 * carries on: `dispose` only stops watching. Only `stop` stops the process, including one left by an earlier agent.
 *
 * A process the agent didn't start can't be waited on, so it is watched by checking every second that its pid is
 * still alive. If it has died, it is started again after a backoff, and the status says so.
 */
export class AdoptedProcess {
  readonly status$ = new BehaviorSubject<ProcessStatus>(STOPPED);
  /** Where the process's pid is kept; its key is recorded beside it, and its log written beside that. */
  readonly pidfile: string;
  private readonly keyfile: string;
  private readonly log: string;
  private readonly serially = exclusive();
  private current: Current | undefined = undefined;
  /** What should be running; `undefined` once stopped. */
  private wanted: Run | undefined = undefined;
  private crashes = 0;
  private watching: ReturnType<typeof setInterval> | undefined = undefined;
  private restart: ReturnType<typeof setTimeout> | undefined = undefined;
  private disposed = false;

  constructor(
    private readonly directory: string,
    private readonly definition: ProcessDefinition
  ) {
    this.pidfile = join(directory, `${definition.name}.pid`);
    this.keyfile = join(directory, `${definition.name}.key`);
    this.log = join(directory, `${definition.name}.log`);
  }

  /** Has a process from `run`'s key up, answering and configured. Resolves with its pid. */
  ensure(run: Run, signal: AbortSignal): Promise<number> {
    this.wanted = run;
    return this.serially(() => this.serve(run, signal));
  }

  /** Stops the process, whatever it was started for, including one left running by an earlier agent. */
  stop(): Promise<void> {
    this.wanted = undefined;
    clearTimeout(this.restart);
    clearInterval(this.watching);
    return this.serially(async () => {
      const pid = this.current?.pid ?? (await findProcess(this.pidfile, this.definition));
      this.current = undefined;
      if (pid !== undefined) await stopProcess(pid, this.definition);
      await rm(this.pidfile, { force: true });
      await rm(this.keyfile, { force: true });
      this.update({ state: 'stopped', pid: null, lastError: null });
    });
  }

  /** The agent is stopping. The process is left running for the next agent to adopt; only the watching stops. */
  dispose(): void {
    this.disposed = true;
    clearTimeout(this.restart);
    clearInterval(this.watching);
    this.status$.complete();
  }

  private async serve(run: Run, signal: AbortSignal): Promise<number> {
    const pid = await this.running(run, signal);
    await run.configure?.(signal);
    this.crashes = 0;
    this.update({ state: 'running', pid, lastError: null });
    return pid;
  }

  /** The pid of a process from `run`'s key that is up. */
  private async running(run: Run, signal: AbortSignal): Promise<number> {
    const current = this.current;
    if (current !== undefined && current.key === run.key && alive(current.pid)) return current.pid;
    // Whatever else is up, the one being watched or one left running by an earlier agent, is adopted if it was
    // started for this key and nobody is watching it yet, and stopped otherwise, so the new one can take its ports.
    this.current = undefined;
    clearInterval(this.watching);
    const found = current !== undefined && alive(current.pid) ? current.pid : await this.find();
    if (found !== undefined) {
      if (current === undefined && (await this.recorded()) === run.key) return this.adopt(found, run.key);
      await stopProcess(found, this.definition);
    }
    await mkdir(this.directory, { recursive: true });
    // Recorded before the process starts: if the agent is killed in between, the next one finds a process started for
    // this key, or none at all. Either way it does the right thing.
    await writeFile(this.keyfile, run.key);
    const pid = await this.spawn(run, signal);
    return this.adopt(pid, run.key);
  }

  private adopt(pid: number, key: string): number {
    this.current = { pid, key };
    this.watch(pid);
    return pid;
  }

  /**
   * Starts the process detached, logging to its file through a descriptor of its own: writing through pipes to the
   * agent would keep the agent alive, and break the process's output once it exits. Resolves once it answers.
   */
  private async spawn(run: Run, signal: AbortSignal): Promise<number> {
    this.update({ state: 'starting', pid: null });
    const log = await open(this.log, 'a');
    const cwd = run.cwd ?? this.directory;
    const subprocess = spawn(run.binary, run.args, { cwd, detached: true, stdio: ['ignore', log.fd, log.fd] });
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
    if (pid === undefined) throw new Error(`${this.definition.name} could not be started`);
    await writeFile(this.pidfile, String(pid));
    try {
      await ready(this.definition, signal, () => !alive(pid));
      return pid;
    } catch (error) {
      // Half started: don't leave it behind.
      await stopProcess(pid, this.definition);
      throw error;
    }
  }

  private find(): Promise<number | undefined> {
    return findProcess(this.pidfile, this.definition);
  }

  private recorded(): Promise<string | undefined> {
    return readFile(this.keyfile, 'utf8').catch(() => undefined);
  }

  /** Checks every second that the process is still alive; if it has died, starts it again after a backoff. */
  private watch(pid: number): void {
    clearInterval(this.watching);
    this.watching = setInterval(() => {
      if (alive(pid) || this.current?.pid !== pid) return;
      clearInterval(this.watching);
      this.current = undefined;
      this.died(`process ${pid} died`);
    }, WATCH_INTERVAL_MS);
    this.watching.unref();
  }

  private died(lastError: string): void {
    const run = this.wanted;
    if (run === undefined || this.disposed) return;
    this.crashes++;
    const { restarts } = this.status$.getValue();
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

  private update(change: Partial<ProcessStatus>): void {
    if (this.disposed) return;
    const current = this.status$.getValue();
    this.status$.next({ ...current, ...change });
  }
}
