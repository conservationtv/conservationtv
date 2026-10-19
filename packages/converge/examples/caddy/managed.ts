import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BehaviorSubject, type Subscription } from 'rxjs';
import { z } from 'zod';
import { AdoptedCaddyRuntime } from './adopted.ts';
import { CaddyAdmin, type CaddyStatus, CaddySpecSchema, STOPPED, findCaddy, stopCaddy } from './caddy.ts';
import { BinarySchema, type Installed, Vendor } from './vendor.ts';

/** What Caddy should serve, and which Caddy should serve it. */
export const ManagedCaddySpecSchema = CaddySpecSchema.extend({ caddy: BinarySchema });
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

/** Which install the Caddy left running was started from, recorded beside its pidfile. */
const BinaryRecordSchema = z.object({ id: z.string() });
type BinaryRecord = z.output<typeof BinaryRecordSchema>;

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
 * across agent restarts too: which install the running Caddy came from is recorded beside its pidfile, so an agent
 * that starts to find the version changed while it was away replaces Caddy rather than adopting the old one.
 */
export class ManagedCaddyRuntime {
  readonly status$ = new BehaviorSubject<ManagedCaddyStatus>(STOPPED_MANAGED);
  private readonly vendor: Vendor;
  private readonly admin: CaddyAdmin;
  private readonly record: string;
  private current: Current | undefined = undefined;

  constructor(private readonly options: ManagedCaddyOptions) {
    this.vendor = new Vendor(join(options.directory, 'binaries'), 'caddy');
    this.admin = new CaddyAdmin(options.admin);
    this.record = join(options.directory, 'binary.json');
  }

  /** Installs the binary the spec names if need be, switches Caddy to it if it isn't running it, then serves the site. */
  async execute(spec: ManagedCaddySpec, signal: AbortSignal): Promise<void> {
    this.update({ installing: true });
    const installed = await this.vendor.install(spec.caddy, signal).finally(() => this.update({ installing: false }));
    if (this.current?.installed.id !== installed.id) await this.switchTo(installed);
    const runtime = this.current?.runtime;
    if (runtime === undefined) throw new Error('No Caddy runtime to serve with');
    await runtime.execute({ port: spec.port, body: spec.body }, signal);
    await this.vendor.prune(installed);
  }

  /**
   * Stops Caddy, whichever binary it came from, including one left running by an earlier agent. Then removes the
   * vendored binaries too: removing the key removes everything it put there.
   */
  async finalize(): Promise<void> {
    const current = this.current;
    this.current = undefined;
    current?.watching.unsubscribe();
    if (current !== undefined) await current.runtime.finalize();
    else await this.stopLeftover();
    await this.vendor.clear();
    await rm(this.record, { force: true });
    this.status$.next(STOPPED_MANAGED);
  }

  /** The agent is stopping. Caddy is left running for the next agent to adopt, as with the adopting runtime. */
  dispose(): void {
    this.current?.watching.unsubscribe();
    this.current?.runtime.dispose();
    this.status$.complete();
  }

  /**
   * Moves to `installed`. A Caddy left running by an earlier agent is adopted if it came from this very install;
   * otherwise it, or the Caddy this runtime is running, is stopped, so the new binary can take the port.
   */
  private async switchTo(installed: Installed): Promise<void> {
    const previous = this.current;
    this.current = undefined;
    previous?.watching.unsubscribe();
    if (previous !== undefined) await previous.runtime.finalize();
    else if ((await this.recorded()) !== installed.id) await this.stopLeftover();
    // Recorded before Caddy starts: if the agent is killed in between, the next one finds a Caddy that came from this
    // install, or none at all. Either way it does the right thing.
    const record: BinaryRecord = { id: installed.id };
    await writeFile(this.record, JSON.stringify(record));
    const runtime = new AdoptedCaddyRuntime({ ...this.options, binary: installed.path });
    const watching = runtime.status$.subscribe(status => this.update({ ...status, version: installed.version }));
    this.current = { runtime, installed, watching };
  }

  private async stopLeftover(): Promise<void> {
    const pid = await findCaddy({ ...this.options, binary: 'caddy' }, this.admin);
    if (pid !== undefined) await stopCaddy(pid, this.admin);
  }

  private async recorded(): Promise<string | undefined> {
    const text = await readFile(this.record, 'utf8').catch(() => undefined);
    if (text === undefined) return undefined;
    const parsed = BinaryRecordSchema.safeParse(JSON.parse(text));
    if (!parsed.success) return undefined;
    const record: BinaryRecord = parsed.data;
    return record.id;
  }

  private update(change: Partial<ManagedCaddyStatus>): void {
    if (this.status$.closed) return;
    this.status$.next({ ...this.status$.getValue(), ...change });
  }
}
