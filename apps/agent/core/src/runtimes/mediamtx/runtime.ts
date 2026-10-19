import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BinaryStore, type Installed } from '@conservationtv/converge/binaries';
import { BehaviorSubject, type Subscription } from 'rxjs';
import { z } from 'zod';
import type { AgentConfiguration } from '../../config.ts';
import { MetricReporter } from '../reports.ts';
import { mediamtxBinary } from './binary.ts';
import { type MediamtxAddresses, renderConfig } from './config.ts';
import { METRICS_STOPPED, MediamtxMetrics, type MediamtxMetricsStatus } from './metrics.ts';
import {
  MediamtxControl,
  alive,
  describe,
  exclusive,
  findMediamtx,
  restartDelay,
  spawnMediamtx,
  stopMediamtx
} from './process.ts';

const WATCH_INTERVAL_MS = 1_000;

/** Which MediaMTX to run, and how often to ship its metrics. */
export const MediamtxSpecSchema = z.object({
  binary: mediamtxBinary.schema,
  /** How often to read MediaMTX's metrics page and submit what it says. */
  metricsIntervalMs: z.number().int().min(1_000)
});
export type MediamtxSpec = z.output<typeof MediamtxSpecSchema>;

/** The room the runtime is given to run MediaMTX in. */
export interface MediamtxRuntimeOptions extends MediamtxAddresses {
  /** A directory of its own: vendored binaries under `binaries/`, and MediaMTX's config, pidfile and log. */
  directory: string;
}

export interface MediamtxStatus {
  state: 'stopped' | 'starting' | 'running' | 'crashed';
  /** The version of MediaMTX running, or being started. */
  version: string | null;
  /** Whether a binary is being downloaded and checked. */
  installing: boolean;
  pid: number | null;
  /** How many times it has been started again after it died. */
  restarts: number;
  /** Why it last died, or could not be started. */
  lastError: string | null;
  metrics: MediamtxMetricsStatus;
}

const STOPPED: MediamtxStatus = {
  state: 'stopped',
  version: null,
  installing: false,
  pid: null,
  restarts: 0,
  lastError: null,
  metrics: METRICS_STOPPED
};

/** Which install the MediaMTX left running was started from, recorded beside its pidfile. */
const BinaryRecordSchema = z.object({ id: z.string() });
type BinaryRecord = z.output<typeof BinaryRecordSchema>;

/** The MediaMTX being watched, and the install it runs. */
interface Current {
  installed: Installed;
  pid: number;
}

/**
 * MediaMTX as a process of its own, outliving the agent, from a binary the runtime vendors itself. The spec names a
 * version, with a download and a checksum for each platform; the runtime installs it into its own directory, writes
 * the config beside it and runs it detached, recording its pid. When the agent stops, MediaMTX carries on serving.
 * When the agent starts again, it finds MediaMTX through the pidfile, checks it really is the one it left and that it
 * came from the install the spec now names, and adopts it without a restart; otherwise it is replaced. Only removing
 * the key, through `finalize`, stops MediaMTX.
 *
 * The config is written on every apply, before MediaMTX reads it: a running MediaMTX watches its file and reloads what
 * changed, so a changed config is a reload in place while a changed version replaces the process. A process the agent
 * didn't start can't be waited on, so MediaMTX is watched by checking every second that its pid is still alive. If it
 * has died, it is started again after a backoff, and the status says so.
 */
export class MediamtxRuntime {
  readonly status$ = new BehaviorSubject<MediamtxStatus>(STOPPED);
  private readonly binaries: BinaryStore;
  private readonly control: MediamtxControl;
  private readonly metrics: MediamtxMetrics;
  private readonly watchingMetrics: Subscription;
  private readonly serially = exclusive();
  private readonly configFile: string;
  private readonly pidfile: string;
  private readonly log: string;
  private readonly record: string;
  private current: Current | undefined = undefined;
  /** What should be running; `undefined` once removed. */
  private wanted: MediamtxSpec | undefined = undefined;
  private crashes = 0;
  private watching: ReturnType<typeof setInterval> | undefined = undefined;
  private restart: ReturnType<typeof setTimeout> | undefined = undefined;
  private disposed = false;

  constructor(
    private readonly config: AgentConfiguration,
    private readonly options: MediamtxRuntimeOptions
  ) {
    this.binaries = new BinaryStore({ directory: join(options.directory, 'binaries') });
    this.control = new MediamtxControl(options.api);
    this.metrics = new MediamtxMetrics(options.metrics, new MetricReporter(config));
    this.watchingMetrics = this.metrics.status$.subscribe(metrics => this.update({ metrics }));
    this.configFile = join(options.directory, 'mediamtx.yml');
    this.pidfile = join(options.directory, 'mediamtx.pid');
    this.log = join(options.directory, 'mediamtx.log');
    this.record = join(options.directory, 'binary.json');
  }

  /**
   * Installs the binary the spec names if need be, has a MediaMTX from it serving the config, then ships its metrics.
   * Resolves once MediaMTX is serving.
   */
  async execute(spec: MediamtxSpec, signal: AbortSignal): Promise<void> {
    this.wanted = spec;
    this.update({ installing: true });
    const installed = await this.binaries
      .install(mediamtxBinary, spec.binary, signal)
      .finally(() => this.update({ installing: false }));
    await this.serially(() => this.serve(installed, signal));
    // A direct agent has no studio API to ship to.
    if (this.config.type !== 'direct') this.metrics.start(spec.metricsIntervalMs);
    await this.binaries.prune(installed, { spare: 1 });
  }

  /**
   * Stops MediaMTX, whichever binary it came from, including one left running by an earlier agent. Then removes the
   * vendored binaries too: removing the key removes everything it put there.
   */
  finalize(): Promise<void> {
    this.wanted = undefined;
    this.metrics.stop();
    clearTimeout(this.restart);
    clearInterval(this.watching);
    return this.serially(async () => {
      const pid = this.current?.pid ?? (await findMediamtx(this.pidfile, this.control));
      this.current = undefined;
      if (pid !== undefined) await stopMediamtx(pid);
      await rm(this.pidfile, { force: true });
      await rm(this.record, { force: true });
      await this.binaries.clear();
      this.update({ state: 'stopped', version: null, pid: null, lastError: null });
    });
  }

  /** The agent is stopping. MediaMTX is left running for the next agent to adopt; only the watching stops. */
  dispose(): void {
    this.disposed = true;
    clearTimeout(this.restart);
    clearInterval(this.watching);
    this.watchingMetrics.unsubscribe();
    this.metrics.dispose();
    this.status$.complete();
  }

  /** Writes the config, then has a MediaMTX from `installed` serving it. */
  private async serve(installed: Installed, signal: AbortSignal): Promise<void> {
    await mkdir(this.options.directory, { recursive: true });
    // Before MediaMTX reads it, or re-reads it: a running MediaMTX reloads its file whenever it is written, so one
    // already serving this config is left undisturbed.
    const config = await renderConfig(this.options);
    const written = await readFile(this.configFile, 'utf8').catch(() => undefined);
    if (written !== config) await writeFile(this.configFile, config);
    const pid = await this.running(installed, signal);
    this.crashes = 0;
    this.update({ state: 'running', pid, version: installed.version, lastError: null });
  }

  /**
   * The pid of a MediaMTX from `installed` that is up: the one being watched, one left running by an earlier agent
   * and recorded as from this very install, or a new one. Any other MediaMTX found, from another install or this
   * runtime's own from an earlier spec, is stopped first, so the new binary can take the ports.
   */
  private async running(installed: Installed, signal: AbortSignal): Promise<number> {
    const current = this.current;
    if (current?.installed.id === installed.id && alive(current.pid)) return current.pid;
    const found =
      current !== undefined && alive(current.pid) ? current.pid : await findMediamtx(this.pidfile, this.control);
    this.current = undefined;
    if (found !== undefined && current === undefined && (await this.recorded()) === installed.id) {
      this.current = { installed, pid: found };
      this.watch(found);
      return found;
    }
    if (found !== undefined) await stopMediamtx(found);
    // Recorded before MediaMTX starts: if the agent is killed in between, the next one finds a MediaMTX that came
    // from this install, or none at all. Either way it does the right thing.
    const record: BinaryRecord = { id: installed.id };
    await writeFile(this.record, JSON.stringify(record));
    const pid = await this.spawn(installed, signal);
    this.current = { installed, pid };
    this.watch(pid);
    return pid;
  }

  private async spawn(installed: Installed, signal: AbortSignal): Promise<number> {
    this.update({ state: 'starting', pid: null, version: installed.version });
    const pid = await spawnMediamtx(installed.path, this.configFile, this.log, this.options.directory);
    await writeFile(this.pidfile, String(pid));
    try {
      await this.control.ready(signal, () => !alive(pid));
      return pid;
    } catch (error) {
      // Half started: don't leave it behind.
      await stopMediamtx(pid);
      throw error;
    }
  }

  /** Checks every second that MediaMTX is still alive; if it has died, starts it again after a backoff. */
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
    const spec = this.wanted;
    if (spec === undefined || this.disposed) return;
    this.crashes++;
    const { restarts } = this.status$.getValue();
    this.update({ state: 'crashed', pid: null, restarts: restarts + 1, lastError });
    this.restart = setTimeout(() => this.revive(spec), restartDelay(this.crashes));
  }

  private revive(spec: MediamtxSpec): void {
    const restarting = this.serially(async () => {
      if (this.wanted !== spec || this.disposed) return;
      const installed = await this.binaries.install(mediamtxBinary, spec.binary, AbortSignal.timeout(30_000));
      await this.serve(installed, AbortSignal.timeout(30_000));
    });
    restarting.catch((error: Error) => {
      if (this.wanted !== spec || this.disposed) return;
      this.crashes++;
      this.update({ state: 'crashed', lastError: describe(error) });
      this.restart = setTimeout(() => this.revive(spec), restartDelay(this.crashes));
    });
  }

  private async recorded(): Promise<string | undefined> {
    const text = await readFile(this.record, 'utf8').catch(() => undefined);
    if (text === undefined) return undefined;
    const parsed = BinaryRecordSchema.safeParse(JSON.parse(text));
    if (!parsed.success) return undefined;
    const record: BinaryRecord = parsed.data;
    return record.id;
  }

  private update(change: Partial<MediamtxStatus>): void {
    if (this.disposed) return;
    const current = this.status$.getValue();
    this.status$.next({ ...current, ...change });
  }
}
