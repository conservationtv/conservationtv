import { mkdir, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { join } from 'node:path';
import {
  type ProcessDefinition,
  type ProcessStatus,
  STOPPED as PROCESS_STOPPED
} from '@conservationtv/converge/process';
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
  /** A directory of its own, for its boot config, pidfile and log. */
  directory: string;
}

export interface CaddyStatus extends ProcessStatus {
  /** The spec Caddy is serving, once it has loaded it. */
  serving: CaddySpec | null;
}

export const STOPPED: CaddyStatus = { ...PROCESS_STOPPED, serving: null };

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
  async alive(signal: AbortSignal = AbortSignal.timeout(1_000)): Promise<boolean> {
    try {
      const response = await this.send('GET', '/config/', undefined, signal);
      return response.ok;
    } catch {
      return false;
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

/** Caddy as a process: told apart by its name, probed and stopped through its admin API. */
export function caddyProcess(admin: CaddyAdmin): ProcessDefinition {
  return { name: 'caddy', probe: signal => admin.alive(signal), stop: () => admin.stop() };
}
