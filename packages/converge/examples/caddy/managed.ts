import { join } from 'node:path';
import { BehaviorSubject, type Subscription } from 'rxjs';
import { BinaryStore, type Installed, defineBinary, reportsVersion } from '@conservationtv/converge/binaries';
import { z } from 'zod';
import { AdoptedCaddyRuntime } from './adopted.ts';
import { type CaddyStatus, CaddySpecSchema, STOPPED } from './caddy.ts';

/** Caddy's releases: a tarball or zip per platform, and `caddy version` reports the version. */
export const caddyBinary = defineBinary({ name: 'caddy', checks: [reportsVersion(['version'])] });

/** What Caddy should serve, and which Caddy should serve it. */
export const ManagedCaddySpecSchema = CaddySpecSchema.extend({ caddy: caddyBinary.schema });
export type ManagedCaddySpec = z.output<typeof ManagedCaddySpecSchema>;

/** Where the runtime keeps Caddy, its vendored binaries, and the room to run them in. */
export interface ManagedCaddyOptions {
  /** Where Caddy's admin API listens, such as `localhost:2999`. */
  admin: string;
  /** A directory of its own: vendored binaries under `binaries/`, and Caddy's pidfile, log and boot config. */
  directory: string;
}

export interface ManagedCaddyStatus extends CaddyStatus {
  /** The version of Caddy running, or being started. */
  version: string | null;
  /** Whether a binary is being downloaded and checked. */
  installing: boolean;
}

const STOPPED_MANAGED: ManagedCaddyStatus = { ...STOPPED, version: null, installing: false };

/** The adopting runtime for the binary in use, the install it runs, and the forwarding of its status. */
interface Current {
  runtime: AdoptedCaddyRuntime;
  installed: Installed;
  watching: Subscription;
}

/**
 * The adopting runtime, also managing which Caddy binary it runs. The spec names a version, with a download and a
 * checksum for each platform; the runtime vendors that binary into its own directory and runs it.
 *
 * Changing only what Caddy serves is still a reload in place. Changing the version replaces the process: the old
 * Caddy is stopped, then the new binary started, with a moment's downtime while the port changes hands. That holds
 * across agent restarts too: each install's path is its own, and is the key the adopting runtime starts Caddy for,
 * so an agent that starts to find the version changed while it was away replaces Caddy rather than adopting the
 * old one.
 */
export class ManagedCaddyRuntime {
  readonly status$ = new BehaviorSubject<ManagedCaddyStatus>(STOPPED_MANAGED);
  private readonly binaries: BinaryStore;
  private current: Current | undefined = undefined;

  constructor(private readonly options: ManagedCaddyOptions) {
    this.binaries = new BinaryStore({ directory: join(options.directory, 'binaries') });
  }

  /** Installs the binary the spec names if need be, switches Caddy to it if it isn't running it, then serves the site. */
  async execute(spec: ManagedCaddySpec, signal: AbortSignal): Promise<void> {
    this.update({ installing: true });
    const installed = await this.binaries
      .install(caddyBinary, spec.caddy, signal)
      .finally(() => this.update({ installing: false }));
    const runtime = this.current?.installed.id === installed.id ? this.current.runtime : this.switchTo(installed);
    await runtime.execute({ port: spec.port, body: spec.body }, signal);
    await this.binaries.prune(installed, { spare: 1 });
  }

  /**
   * Stops Caddy, whichever binary it came from, including one left running by an earlier agent: a leftover is found
   * through the pidfile whatever it was started for. Then removes the vendored binaries too: removing the key removes
   * everything it put there.
   */
  async finalize(): Promise<void> {
    const current = this.current;
    this.current = undefined;
    current?.watching.unsubscribe();
    const runtime = current?.runtime ?? new AdoptedCaddyRuntime({ ...this.options, binary: 'caddy' });
    await runtime.finalize();
    runtime.dispose();
    await this.binaries.clear();
    this.status$.next(STOPPED_MANAGED);
  }

  /** The agent is stopping. Caddy is left running for the next agent to adopt, as with the adopting runtime. */
  dispose(): void {
    this.current?.watching.unsubscribe();
    this.current?.runtime.dispose();
    this.status$.complete();
  }

  /**
   * Moves to `installed`: an adopting runtime for its binary, in the same directory. The Caddy from the previous
   * install is no longer watched; the new runtime finds it through the pidfile and, started for another key,
   * replaces it. One left by an earlier agent from this very install is adopted.
   */
  private switchTo(installed: Installed): AdoptedCaddyRuntime {
    const previous = this.current;
    previous?.watching.unsubscribe();
    previous?.runtime.dispose();
    const runtime = new AdoptedCaddyRuntime({ ...this.options, binary: installed.path });
    const watching = runtime.status$.subscribe(status => this.update({ ...status, version: installed.version }));
    this.current = { runtime, installed, watching };
    return runtime;
  }

  private update(change: Partial<ManagedCaddyStatus>): void {
    if (this.status$.closed) return;
    this.status$.next({ ...this.status$.getValue(), ...change });
  }
}
