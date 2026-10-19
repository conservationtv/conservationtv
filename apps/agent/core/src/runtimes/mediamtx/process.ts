import { spawn } from 'node:child_process';
import { open, readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { MediamtxApi, createClient, createConfig } from '@conservationtv/mediamtx/api';
import psList from 'ps-list';
import treeKill from 'tree-kill';

// MediaMTX as a process of its own, outliving the agent: started detached, writing its log to a file through a
// descriptor of its own, and found again through a pidfile. MediaMTX takes no pidfile flag, so the runtime writes
// the pid itself, right after starting it.

const READY_TIMEOUT_MS = 10_000;
const STOP_GRACE_MS = 5_000;
const RESTART_BASE_MS = 1_000;
const RESTART_MAX_MS = 30_000;

/** How long to wait before starting MediaMTX again after it has died `crashes` times in a row. */
export function restartDelay(crashes: number): number {
  return Math.min(RESTART_BASE_MS * 2 ** (crashes - 1), RESTART_MAX_MS);
}

/** MediaMTX's control API, used here only to tell that a MediaMTX is up and answering. */
export class MediamtxControl {
  private readonly api: MediamtxApi;

  /** @param address Where the API listens, such as `127.0.0.1:9997`. */
  constructor(address: string) {
    const client = createClient(createConfig({ baseUrl: `http://${address}` }));
    this.api = new MediamtxApi({ client });
  }

  /** Whether a MediaMTX is answering on the API. */
  async alive(): Promise<boolean> {
    try {
      const { response } = await this.api.info({ signal: AbortSignal.timeout(1_000) });
      return response?.ok === true;
    } catch {
      return false;
    }
  }

  /** Waits until MediaMTX answers, giving up if `signal` aborts, `gone()` says it died, or it takes too long. */
  async ready(signal: AbortSignal, gone: () => boolean): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (!(await this.alive())) {
      signal.throwIfAborted();
      if (gone()) throw new Error('MediaMTX exited before it was ready');
      if (Date.now() > deadline) throw new Error('MediaMTX did not answer on its API in time');
      await delay(100, undefined, { signal });
    }
  }
}

/**
 * Starts MediaMTX on `config`, detached, logging to `log`. Resolves with its pid once it has started, before it is
 * ready. Plain `spawn`, not execa: execa is built around owning its child, which a detached MediaMTX lets go of.
 */
export async function spawnMediamtx(binary: string, config: string, log: string, cwd: string): Promise<number> {
  const file = await open(log, 'a');
  const subprocess = spawn(binary, [config], { cwd, detached: true, stdio: ['ignore', file.fd, file.fd] });
  subprocess.unref();
  // Listen before awaiting anything else: `spawn` or `error` fires on the next tick.
  const started = new Promise<Error | undefined>(resolve => {
    subprocess.once('spawn', () => resolve(undefined));
    subprocess.once('error', resolve);
  });
  await file.close();
  const failed = await started;
  if (failed !== undefined) throw failed;
  const pid = subprocess.pid;
  if (pid === undefined) throw new Error('MediaMTX could not be started');
  return pid;
}

/**
 * The MediaMTX recorded in `pidfile`, if it is still alive, really is MediaMTX (a pid can be reused by an unrelated
 * process), and answers on its API.
 */
export async function findMediamtx(pidfile: string, control: MediamtxControl): Promise<number | undefined> {
  const recorded = await readFile(pidfile, 'utf8').catch(() => undefined);
  const pid = Number(recorded);
  if (!Number.isInteger(pid) || !alive(pid)) return undefined;
  const processes = await psList();
  const found = processes.find(each => each.pid === pid);
  if (found === undefined || !found.name.toLowerCase().startsWith('mediamtx')) return undefined;
  if (!(await control.alive())) return undefined;
  return pid;
}

/**
 * Stops the MediaMTX at `pid`: asks it to shut down with SIGTERM, which it handles gracefully, then kills it and
 * anything it started if it hasn't gone within the grace period.
 */
export async function stopMediamtx(pid: number): Promise<void> {
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
