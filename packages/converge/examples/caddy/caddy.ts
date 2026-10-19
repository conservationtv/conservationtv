import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import psList from 'ps-list';
import treeKill from 'tree-kill';
import { z } from 'zod';

/** What Caddy should serve: one site, answering every request with the same body. */
export const CaddySpecSchema = z.object({
  /** The port the site listens on. */
  port: z.number().int().min(1).max(65535),
  /** What every request is answered with. */
  body: z.string()
});
export type CaddySpec = z.output<typeof CaddySpecSchema>;

/** Where a runtime finds Caddy, and the room it is given to run it in. */
export interface CaddyOptions {
  /** The caddy binary: a path, or a name on `PATH`. */
  binary: string;
  /** Where its admin API listens, such as `localhost:2999`. Each runtime needs its own. */
  admin: string;
  /** A directory of its own, for its boot config, and its pidfile and log when it runs detached. */
  directory: string;
}

export interface CaddyStatus {
  state: 'stopped' | 'starting' | 'running' | 'crashed';
  pid: number | null;
  /** The spec Caddy is serving, once it has loaded it. */
  serving: CaddySpec | null;
  /** How many times it has been started again after it died. */
  restarts: number;
  /** Why it last died. */
  lastError: string | null;
}

export const STOPPED: CaddyStatus = { state: 'stopped', pid: null, serving: null, restarts: 0, lastError: null };

const READY_TIMEOUT_MS = 10_000;
const STOP_GRACE_MS = 5_000;
const RESTART_BASE_MS = 1_000;
const RESTART_MAX_MS = 30_000;

/** How long to wait before starting Caddy again after it has died `crashes` times in a row. */
export function restartDelay(crashes: number): number {
  return Math.min(RESTART_BASE_MS * 2 ** (crashes - 1), RESTART_MAX_MS);
}

/**
 * Writes the config Caddy boots with: only its admin API, with nothing persisted to Caddy's own data directory. The
 * site arrives afterwards through `load`, so starting Caddy and changing what it serves are one path.
 */
export async function writeBootConfig(options: CaddyOptions): Promise<string> {
  await mkdir(options.directory, { recursive: true });
  const path = join(options.directory, 'boot.json');
  await writeFile(path, JSON.stringify(adminConfig(options.admin)));
  return path;
}

function adminConfig(admin: string) {
  return { admin: { listen: admin, config: { persist: false } } };
}

/**
 * Caddy's admin API: the one channel that can stop it gracefully on every platform, Windows included. Spoken through
 * `node:http`, not `fetch`: `fetch` sends the `Sec-Fetch-*` headers of a browser, and Caddy refuses those, to keep
 * websites away from a local admin API.
 */
export class CaddyAdmin {
  constructor(private readonly address: string) {}

  /** Whether Caddy is answering on its admin API. */
  async alive(): Promise<boolean> {
    try {
      const response = await this.send('GET', '/config/', undefined, AbortSignal.timeout(1_000));
      return response.ok;
    } catch {
      return false;
    }
  }

  /** Waits until Caddy answers, giving up if `signal` aborts, `gone()` says it died, or it takes too long. */
  async ready(signal: AbortSignal, gone: () => boolean): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (!(await this.alive())) {
      signal.throwIfAborted();
      if (gone()) throw new Error('Caddy exited before it was ready');
      if (Date.now() > deadline) throw new Error('Caddy did not answer on its admin API in time');
      await delay(100, undefined, { signal });
    }
  }

  /** Serves `spec`. Caddy swaps configs without dropping connections, and does nothing if it is unchanged. */
  async load(spec: CaddySpec, signal: AbortSignal): Promise<void> {
    const site = { listen: [`:${spec.port}`], routes: [{ handle: [{ handler: 'static_response', body: spec.body }] }] };
    const config = { ...adminConfig(this.address), apps: { http: { servers: { site } } } };
    const response = await this.send('POST', '/load', JSON.stringify(config), signal);
    if (!response.ok) throw new Error(`Caddy refused the config: ${response.body}`);
  }

  /** Asks Caddy to shut down gracefully. Whether it does is for the caller to check. */
  async stop(): Promise<void> {
    await this.send('POST', '/stop', undefined, AbortSignal.timeout(2_000)).catch(() => undefined);
  }

  private send(method: string, path: string, body: string | undefined, signal: AbortSignal): Promise<AdminResponse> {
    return new Promise((resolve, reject) => {
      const headers = body === undefined ? {} : { 'Content-Type': 'application/json' };
      const sent = request(`http://${this.address}${path}`, { method, headers, signal }, response => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('error', reject);
        response.on('end', () => {
          const status = response.statusCode ?? 0;
          resolve({ ok: status >= 200 && status < 300, body: Buffer.concat(chunks).toString() });
        });
      });
      sent.on('error', reject);
      sent.end(body);
    });
  }
}

/** What the admin API answered. */
interface AdminResponse {
  ok: boolean;
  body: string;
}

/** Where a runtime records the pid of its Caddy. */
export function pidfile(options: CaddyOptions): string {
  return join(options.directory, 'caddy.pid');
}

/**
 * The Caddy recorded in `options`' pidfile, if it is still alive, really is Caddy (a pid can be reused by an unrelated
 * process), and answers on its admin API.
 */
export async function findCaddy(options: CaddyOptions, admin: CaddyAdmin): Promise<number | undefined> {
  const recorded = await readFile(pidfile(options), 'utf8').catch(() => undefined);
  const pid = Number(recorded);
  if (!Number.isInteger(pid) || !alive(pid)) return undefined;
  const processes = await psList();
  const found = processes.find(each => each.pid === pid);
  if (found === undefined || !found.name.toLowerCase().startsWith('caddy')) return undefined;
  if (!(await admin.alive())) return undefined;
  return pid;
}

/**
 * Stops the Caddy at `pid`: asks it to shut down through its admin API, then kills it and anything it started if it
 * hasn't gone within the grace period.
 */
export async function stopCaddy(pid: number, admin: CaddyAdmin): Promise<void> {
  await admin.stop();
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
