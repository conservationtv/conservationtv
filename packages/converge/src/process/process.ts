import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { BehaviorSubject } from 'rxjs';
import treeKill from 'tree-kill';
import { z } from 'zod';
import { type ProcessInfo, portHolders, processInfo } from './system.ts';

// A process of its own, outliving the agent: started detached, with its log on a file, and found again through a
// record in a directory of its own. The record says which process it is (its pid, and when it started, so a reused pid
// isn't mistaken for it), what it was started for (a key, so the next agent knows whether it is what the spec now asks
// for) and as which instance: a name of its own, which a process that can say who it is answers with, so a process
// answering on the same ports isn't mistaken for it either.

/** How a runtime's process is told apart from any other, probed, and asked to stop. */
export interface ProcessDefinition {
  /** What `ps` calls it: its executable's name. A pid reused by an unrelated process is told apart by it. */
  name: string;
  /** Whether the process is up and answering, such as on its admin API. `signal` aborts after a second. */
  probe(signal: AbortSignal): Promise<boolean>;
  /**
   * The instance the answering process was started as, read back from it, such as from a marker `Run.prepare` put in
   * its config; `undefined` if it names none. With it, only the instance started counts as answering: another process
   * answering on the same address, as one left by another agent does, doesn't. `signal` aborts after a second.
   */
  identify?(signal: AbortSignal): Promise<string | undefined>;
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
  /**
   * The TCP ports the process listens on. Each must be free before it starts: a process of the same name holding one,
   * as one left by another agent or directory, is stopped, and anything else holding one fails the start, naming it.
   */
  ports?: number[];
  /**
   * Run before the process is adopted or started, with the instance it is or is to be, such as to write the config that
   * names it for `ProcessDefinition.identify`.
   */
  prepare?(instance: string, signal: AbortSignal): Promise<void>;
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
/** How long a process stays up before its crashes are forgotten, and the backoff starts again from a second. */
const STABLE_MS = 30_000;

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

/**
 * Whether the process answers its probe, a probe that throws counting as no; and, given the `instance` it was started
 * as and a definition that can identify it, whether what answers is that instance.
 */
export async function answering(definition: ProcessDefinition, instance?: string): Promise<boolean> {
  const probed = await definition.probe(AbortSignal.timeout(PROBE_TIMEOUT_MS)).catch(() => false);
  if (!probed || instance === undefined || definition.identify === undefined) return probed;
  const identified = await definition.identify(AbortSignal.timeout(PROBE_TIMEOUT_MS)).catch(() => undefined);
  return identified === instance;
}

/**
 * Waits until the process answers, as `instance` if given, giving up if `signal` aborts, `gone()` says it died, or it
 * takes too long.
 */
export async function ready(
  definition: ProcessDefinition,
  signal: AbortSignal,
  gone: () => boolean,
  instance?: string
): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (!(await answering(definition, instance))) {
    signal.throwIfAborted();
    if (gone()) throw new Error(`${definition.name} exited before it was ready`);
    if (Date.now() > deadline) throw new Error(`${definition.name} did not answer in time`);
    await delay(100, undefined, { signal });
  }
}

/** Whether `info` is a process of the definition's: its executable is called by its name. */
function isNamed(info: ProcessInfo, definition: ProcessDefinition): boolean {
  return info.name.toLowerCase().startsWith(definition.name.toLowerCase());
}

/**
 * The process recorded in `pidfile`, if it is still alive, really is the one defined (a pid can be reused by an
 * unrelated process), and answers its probe.
 */
export async function findProcess(pidfile: string, definition: ProcessDefinition): Promise<number | undefined> {
  const recorded = await readFile(pidfile, 'utf8').catch(() => undefined);
  const pid = Number(recorded);
  if (!Number.isInteger(pid) || pid <= 0 || !alive(pid)) return undefined;
  const found = await processInfo(pid);
  if (found === undefined || !isNamed(found, definition)) return undefined;
  if (!(await answering(definition))) return undefined;
  return pid;
}

/**
 * Frees each of `ports` for a process of the definition's to start: one of its kind holding a port is stopped, being
 * left by another agent or directory; anything else holding one is an error naming it, as is a holder that can't be
 * seen, being another user's.
 */
export async function freePorts(ports: number[], definition: ProcessDefinition): Promise<void> {
  for (const port of ports) {
    // A holder nobody can see fails the start, one of another kind fails it naming that, and one of this kind is
    // stopped, a holder gone by the time it is looked at being let be.
    const holders = await portHolders(port);
    if (holders.held && holders.pids.length === 0) {
      throw new Error(`Port ${port} is held by a process that can't be seen, so ${definition.name} can't start`);
    }
    for (const pid of holders.pids) {
      const info = await processInfo(pid);
      if (info === undefined) continue;
      if (!isNamed(info, definition)) {
        throw new Error(`Port ${port} is held by process ${pid} (${info.path}), so ${definition.name} can't start`);
      }
      await stopProcess(pid, definition);
    }
  }
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

/** What the record in the process's directory says: what it was started for, as which instance, and, once started, which process it is. */
const ProcessRecordSchema = z.object({
  key: z.string(),
  instance: z.string(),
  pid: z.number().int().positive().optional(),
  startedAt: z.string().optional()
});
type ProcessRecord = z.output<typeof ProcessRecordSchema>;

/** The process being watched, what it was started for and as which instance, and since when it has been up. */
interface Current {
  pid: number;
  key: string;
  instance: string;
  since: number;
}

/** A process found from its record: alive, the very process recorded, and answering as the instance recorded. */
interface Found {
  pid: number;
  key: string;
  instance: string;
}

/**
 * A process that outlives the agent, adopted when found and replaced when it isn't what is wanted. `ensure` has a
 * process from a `Run`'s key up and answering: the one being watched, one left running by an earlier agent whose
 * record says it is that very process, started for the same key and answering as the instance recorded, or a new
 * one, anything else found being stopped first, and anything of its kind holding its ports too. When the agent stops,
 * the process carries on: `dispose` only stops watching. Only `stop` stops the process, including one left by an
 * earlier agent.
 *
 * A process the agent didn't start can't be waited on, so it is watched by checking every second that its pid is
 * still alive. If it has died, it is started again after a backoff, which only starts again from a second once a
 * process has stayed up for a while, and the status says so.
 */
export class AdoptedProcess {
  readonly status$ = new BehaviorSubject<ProcessStatus>(STOPPED);
  /** Where the process's record is kept, and its log written beside it. */
  private readonly recordfile: string;
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
    this.recordfile = join(directory, `${definition.name}.json`);
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
      // The one being watched, or else the one recorded, if it is still that process; then the record goes too.
      const pid = this.current?.pid ?? (await this.find())?.pid;
      this.current = undefined;
      if (pid !== undefined) await stopProcess(pid, this.definition);
      await rm(this.recordfile, { force: true });
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
    this.update({ state: 'running', pid, lastError: null });
    return pid;
  }

  /** The pid of a process from `run`'s key that is up, prepared for. */
  private async running(run: Run, signal: AbortSignal): Promise<number> {
    const current = this.current;
    if (current !== undefined && current.key === run.key && alive(current.pid)) {
      await run.prepare?.(current.instance, signal);
      return current.pid;
    }
    this.current = undefined;
    clearInterval(this.watching);
    return (await this.adoptFound(current, run, signal)) ?? (await this.start(run, signal));
  }

  /**
   * Whatever else is up, the one being watched or one left running by an earlier agent, is adopted if it was started
   * for this key and nobody is watching it yet, and stopped otherwise, so the new one can take its ports. Resolves with
   * the pid adopted, if any.
   */
  private async adoptFound(current: Current | undefined, run: Run, signal: AbortSignal) {
    const found = current !== undefined && alive(current.pid) ? current : await this.find();
    if (found === undefined) return undefined;
    if (current === undefined && found.key === run.key) {
      await run.prepare?.(found.instance, signal);
      return this.adopt(found);
    }
    await stopProcess(found.pid, this.definition);
    return undefined;
  }

  /** Starts a process from `run`, as a new instance, once its ports are free. */
  private async start(run: Run, signal: AbortSignal): Promise<number> {
    await freePorts(run.ports ?? [], this.definition);
    await mkdir(this.directory, { recursive: true });
    const instance = randomUUID();
    await run.prepare?.(instance, signal);
    // Recorded before the process starts: if the agent is killed in between, the next one finds no process recorded,
    // and frees the ports of the one started, if any, before starting its own.
    await this.record({ key: run.key, instance });
    const pid = await this.spawn(run, instance, signal);
    return this.adopt({ pid, key: run.key, instance });
  }

  private adopt(found: Found): number {
    this.current = { ...found, since: Date.now() };
    this.watch(found.pid);
    return found.pid;
  }

  /**
   * Starts the process detached, logging to its file through a descriptor of its own: writing through pipes to the
   * agent would keep the agent alive, and break the process's output once it exits. Resolves once it answers as
   * `instance`.
   */
  private async spawn(run: Run, instance: string, signal: AbortSignal): Promise<number> {
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
    try {
      const info = await processInfo(pid);
      await this.record({ key: run.key, instance, pid, startedAt: info?.startedAt });
      await ready(this.definition, signal, () => !alive(pid), instance);
      return pid;
    } catch (error) {
      // Half started: don't leave it behind.
      await stopProcess(pid, this.definition);
      throw error;
    }
  }

  /**
   * The process recorded, if it is alive, really is the process recorded (a pid can be reused by an unrelated one,
   * which started at another time) and answers as the instance recorded.
   */
  private async find(): Promise<Found | undefined> {
    const recorded = await this.recorded();
    const { pid, startedAt } = recorded ?? {};
    if (recorded === undefined || pid === undefined || startedAt === undefined || !alive(pid)) return undefined;
    const info = await processInfo(pid);
    if (info === undefined || info.startedAt !== startedAt || !isNamed(info, this.definition)) return undefined;
    if (!(await answering(this.definition, recorded.instance))) return undefined;
    return { pid, key: recorded.key, instance: recorded.instance };
  }

  private async recorded(): Promise<ProcessRecord | undefined> {
    const text = await readFile(this.recordfile, 'utf8').catch(() => undefined);
    if (text === undefined) return undefined;
    try {
      const parsed = ProcessRecordSchema.safeParse(JSON.parse(text));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  private record(record: ProcessRecord): Promise<void> {
    return writeFile(this.recordfile, JSON.stringify(record));
  }

  /**
   * Checks every second that the process is still alive; if it has died, starts it again after a backoff. Once it has
   * stayed up long enough, its crashes are forgotten.
   */
  private watch(pid: number): void {
    clearInterval(this.watching);
    this.watching = setInterval(() => {
      // Another process being watched by now ends this watch's say; a live one long up forgets its crashes, and a dead
      // one is started again.
      if (this.current?.pid !== pid) return;
      if (alive(pid)) {
        if (Date.now() - this.current.since >= STABLE_MS) this.crashes = 0;
        return;
      }
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
