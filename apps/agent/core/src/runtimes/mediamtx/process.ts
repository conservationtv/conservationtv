import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import psList from 'ps-list';
import treeKill from 'tree-kill';
import { z } from 'zod';

// Finding, checking and stopping a MediaMTX the agent didn't necessarily start: one left running by an earlier agent
// is adopted, so it has to be recognised from what was recorded about it.

const READY_TIMEOUT_MS = 10_000;
const STOP_GRACE_MS = 5_000;
const RESTART_BASE_MS = 1_000;
const RESTART_MAX_MS = 30_000;

/** How long to wait before starting MediaMTX again after it has died `crashes` times in a row. */
export function restartDelay(crashes: number): number {
  return Math.min(RESTART_BASE_MS * 2 ** (crashes - 1), RESTART_MAX_MS);
}

/** The running MediaMTX, recorded beside its config: its pid, and which install it was started from. */
export const ProcessRecordSchema = z.object({ pid: z.number().int().positive(), install: z.string() });
export type ProcessRecord = z.output<typeof ProcessRecordSchema>;

/** What `/v3/info` answers, as far as the agent reads it. */
const InfoSchema = z.object({ version: z.string() });
type Info = z.output<typeof InfoSchema>;

/** MediaMTX's control API, on loopback. */
export class MediamtxApi {
  constructor(private readonly address: string) {}

  /** The version MediaMTX reports, or `undefined` if nothing answers. */
  async version(): Promise<string | undefined> {
    try {
      const response = await fetch(`http://${this.address}/v3/info`, { signal: AbortSignal.timeout(1_000) });
      if (!response.ok) return undefined;
      const info: Info = InfoSchema.parse(await response.json());
      return info.version;
    } catch {
      return undefined;
    }
  }

  /** Waits until MediaMTX answers, giving up if `signal` aborts, `gone()` says it died, or it takes too long. */
  async ready(signal: AbortSignal, gone: () => boolean): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while ((await this.version()) === undefined) {
      signal.throwIfAborted();
      if (gone()) throw new Error('MediaMTX exited before it was ready');
      if (Date.now() > deadline) throw new Error('MediaMTX did not answer on its control API in time');
      await delay(100, undefined, { signal });
    }
  }
}

/** The record at `path`, if there is one and it parses. */
export async function readRecord(path: string): Promise<ProcessRecord | undefined> {
  const text = await readFile(path, 'utf8').catch(() => undefined);
  if (text === undefined) return undefined;
  try {
    const parsed = ProcessRecordSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The MediaMTX `record` describes, if it is still alive, really is MediaMTX (a pid can be reused by an unrelated
 * process), and answers on its control API.
 */
export async function isMediamtx(record: ProcessRecord, api: MediamtxApi): Promise<boolean> {
  if (!alive(record.pid)) return false;
  const name = await processName(record.pid);
  if (name === undefined || !name.toLowerCase().startsWith('mediamtx')) return false;
  return (await api.version()) !== undefined;
}

/**
 * The name of the process at `pid`. On Linux it is read from `/proc`, which needs no `ps`: the agent's image has none.
 */
async function processName(pid: number): Promise<string | undefined> {
  if (process.platform === 'linux') {
    const comm = await readFile(`/proc/${pid}/comm`, 'utf8').catch(() => undefined);
    return comm?.trim();
  }
  const processes = await psList();
  const found = processes.find(each => each.pid === pid);
  return found?.name;
}

/**
 * Stops the MediaMTX at `pid`: asks it to shut down with `SIGTERM`, then kills it and anything it started if it hasn't
 * gone within the grace period. MediaMTX has no API to stop it, and on Windows `SIGTERM` is already a kill.
 */
export async function stopMediamtx(pid: number): Promise<void> {
  if (!alive(pid)) return;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return;
  }
  const deadline = Date.now() + STOP_GRACE_MS;
  while (alive(pid) && Date.now() < deadline) await delay(100);
  if (alive(pid)) await new Promise<void>(resolve => treeKill(pid, 'SIGKILL', () => resolve()));
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

/** Runs tasks one at a time, so a restart after a crash never races an `execute` or `finalize`. */
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
