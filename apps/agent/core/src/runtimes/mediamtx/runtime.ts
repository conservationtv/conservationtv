import { spawn } from 'node:child_process';
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BuildDiagnostic } from '@conservationtv/mediamtx';
import { BinaryStore, type Installed } from '@conservationtv/converge/binaries';
import { BehaviorSubject } from 'rxjs';
import { z } from 'zod';
import {
  MAX_BATCH_REPORTS,
  type Metric,
  MetricReporter,
  NOT_REPORTED,
  type ReportingStatus,
  type StudioConnection
} from '../../reporting.ts';
import { mediamtxBinary } from './binary.ts';
import { CONTROL, renderConfig } from './config.ts';
import { scrape } from './metrics.ts';
import {
  MediamtxApi,
  type ProcessRecord,
  alive,
  describe,
  exclusive,
  isMediamtx,
  readRecord,
  restartDelay,
  stopMediamtx
} from './process.ts';

// MediaMTX, managed: the spec names a version with a download and checksum for each platform, which the runtime
// vendors into its own directory and runs with a config of its own (./config.ts). MediaMTX is a process of its own,
// and outlives the agent: stopping the agent leaves it serving, and the next agent adopts it.
//
// Its metrics are read from its Prometheus endpoint on an interval and submitted to the studio API as metrics about
// the agent's device, beside `mediamtx.up`, whether MediaMTX answered at all.

/** What MediaMTX should run, and how often its metrics are shipped. */
export const MediamtxSpecSchema = z.object({
  mediamtx: mediamtxBinary.schema,
  metrics: z.object({
    /** How often to read MediaMTX's metrics and submit them. */
    intervalMs: z.number().int().min(1_000)
  })
});
export type MediamtxSpec = z.output<typeof MediamtxSpecSchema>;

export interface MediamtxMetricsStatus extends ReportingStatus {
  intervalMs: number | null;
  /** ISO 8601: when MediaMTX's metrics were last read. */
  lastScrapedAt: string | null;
  /** Why the last read of MediaMTX's metrics failed; cleared by the next success. */
  lastScrapeError: string | null;
}

export interface MediamtxStatus {
  state: 'stopped' | 'starting' | 'running' | 'crashed';
  pid: number | null;
  /** The version of MediaMTX running, or being started. */
  version: string | null;
  /** Whether a binary is being downloaded and checked. */
  installing: boolean;
  /** How many times it has been started again after it died. */
  restarts: number;
  /** Why it last died, or last failed to start. */
  lastError: string | null;
  /** What rendering MediaMTX's config said, warnings included. */
  diagnostics: BuildDiagnostic[];
  /** Shipping its metrics; `null` for a direct agent, which has nothing to ship them to. */
  metrics: MediamtxMetricsStatus | null;
}

export interface MediamtxOptions {
  /** A directory of its own: vendored binaries under `binaries/`, and MediaMTX's config, record and log. */
  directory: string;
  /** The studio API to ship metrics to; `undefined` for a direct agent. */
  studio: StudioConnection | undefined;
}

const WATCH_INTERVAL_MS = 1_000;
/** How long a restart after a crash gets to install, start and become ready. */
const REVIVE_TIMEOUT_MS = 60_000;
/** Scrapes kept while submissions fail: several of MediaMTX's, which grow with every path and session. */
const METRICS_CAPACITY = 10 * MAX_BATCH_REPORTS;

const STOPPED_METRICS: MediamtxMetricsStatus = {
  ...NOT_REPORTED,
  intervalMs: null,
  lastScrapedAt: null,
  lastScrapeError: null
};

/**
 * MediaMTX, vendored and run as a process of its own. It runs detached, with its pid and the install it came from
 * recorded beside its config. When the agent stops, MediaMTX carries on serving: stopping isn't removing. When the agent
 * starts again, it finds MediaMTX through the record, checks it really is MediaMTX (a pid can be reused) and came from
 * the install the spec asks for, and adopts it without a restart. A MediaMTX from another install is replaced. Only
 * removing the key, through `finalize`, stops it for good.
 *
 * The config is written before MediaMTX is started or adopted, and only when it has changed. MediaMTX watches its config
 * file and reloads it itself, so an adopted MediaMTX picks up a changed config without a restart.
 *
 * A process the agent didn't start can't be waited on, so MediaMTX is watched by checking every second that its pid is
 * still alive. If it has died, it is started again after a backoff, and the status says so.
 */
export class MediamtxRuntime {
  readonly status$: BehaviorSubject<MediamtxStatus>;
  private readonly binaries: BinaryStore;
  private readonly api = new MediamtxApi(CONTROL.api);
  private readonly serially = exclusive();
  private readonly reporter: MetricReporter | undefined;
  private readonly config: string;
  private readonly record: string;
  private readonly log: string;
  /** The MediaMTX being watched. */
  private current: ProcessRecord | undefined = undefined;
  /** What MediaMTX should run; `undefined` once removed. */
  private wanted: MediamtxSpec | undefined = undefined;
  private crashes = 0;
  private watching: ReturnType<typeof setInterval> | undefined = undefined;
  private restart: ReturnType<typeof setTimeout> | undefined = undefined;
  private shipping: ReturnType<typeof setInterval> | undefined = undefined;
  /** Whether a metrics tick is under way: a slow one skips the ticks it overlaps rather than piling up. */
  private ticking = false;
  private disposed = false;

  constructor(private readonly options: MediamtxOptions) {
    const metrics = options.studio === undefined ? null : STOPPED_METRICS;
    this.status$ = new BehaviorSubject<MediamtxStatus>(stopped(metrics));
    this.binaries = new BinaryStore({ directory: join(options.directory, 'binaries') });
    const reporting = { capacity: METRICS_CAPACITY, onChange: (status: ReportingStatus) => this.updateMetrics(status) };
    this.reporter = options.studio === undefined ? undefined : new MetricReporter(options.studio, reporting);
    this.config = join(options.directory, 'mediamtx.yml');
    this.record = join(options.directory, 'process.json');
    this.log = join(options.directory, 'mediamtx.log');
  }

  /**
   * Installs the binary the spec names if need be, then adopts the MediaMTX left running if it came from that install,
   * or starts one. Resolves once it is serving.
   */
  execute(spec: MediamtxSpec, signal: AbortSignal): Promise<void> {
    this.wanted = spec;
    this.ship(spec.metrics.intervalMs);
    return this.serially(() => this.serve(spec, signal));
  }

  /**
   * Stops MediaMTX, including one left running by an earlier agent, and removes the runtime's directory: the vendored
   * binaries and everything written beside them. Removing the key removes everything it put there.
   */
  finalize(): Promise<void> {
    this.wanted = undefined;
    clearTimeout(this.restart);
    clearInterval(this.watching);
    this.stopShipping();
    return this.serially(async () => {
      // Whichever MediaMTX there is, watched or left behind, is stopped; then everything written for it goes.
      const found = this.current ?? (await this.leftover());
      this.current = undefined;
      if (found !== undefined) await stopMediamtx(found.pid);
      await this.binaries.clear();
      // Its config, record and log, and what MediaMTX wrote beside them, such as its generated certificate.
      await rm(this.options.directory, { recursive: true, force: true });
      this.reporter?.clear();
      const current = this.status$.getValue();
      const metrics = current.metrics && { ...current.metrics, intervalMs: null };
      this.update({ ...stopped(metrics), restarts: current.restarts });
    });
  }

  /** The agent is stopping. MediaMTX is left running for the next agent to adopt; only the watching stops. */
  dispose(): void {
    this.disposed = true;
    clearTimeout(this.restart);
    clearInterval(this.watching);
    this.stopShipping();
    this.status$.complete();
  }

  private async serve(spec: MediamtxSpec, signal: AbortSignal): Promise<void> {
    this.update({ installing: true });
    const installed = await this.binaries
      .install(mediamtxBinary, spec.mediamtx, signal)
      .finally(() => this.update({ installing: false }));
    await this.writeConfig();
    const pid = await this.running(installed, signal);
    this.crashes = 0;
    this.update({ state: 'running', pid, version: installed.version });
    // Only once MediaMTX runs from `installed`: if switching failed, the install it ran before is still there.
    await this.binaries.prune(installed, { spare: 1 });
  }

  /** Writes the config, if it has changed. A running MediaMTX notices, and reloads it. */
  private async writeConfig(): Promise<void> {
    const { yaml, diagnostics } = await renderConfig();
    this.update({ diagnostics });
    await mkdir(this.options.directory, { recursive: true });
    const written = await readFile(this.config, 'utf8').catch(() => undefined);
    if (written !== yaml) await writeFile(this.config, yaml);
  }

  /**
   * The pid of a MediaMTX running from `installed`: the one being watched, one left running by an earlier agent, or a
   * new one. One running from another install is stopped first, so the new one can take its ports.
   */
  private async running(installed: Installed, signal: AbortSignal): Promise<number> {
    const watched = this.current !== undefined && alive(this.current.pid) ? this.current : undefined;
    const found = watched ?? (await this.leftover());
    if (found?.install === installed.id) {
      this.adopt(found);
      return found.pid;
    }
    if (found !== undefined) {
      this.current = undefined;
      clearInterval(this.watching);
      await stopMediamtx(found.pid);
      await rm(this.record, { force: true });
    }
    return this.spawn(installed, signal);
  }

  /** The MediaMTX recorded beside the config, if it is still running. */
  private async leftover(): Promise<ProcessRecord | undefined> {
    const record = await readRecord(this.record);
    if (record === undefined || !(await isMediamtx(record, this.api))) return undefined;
    return record;
  }

  private async spawn(installed: Installed, signal: AbortSignal): Promise<number> {
    this.update({ state: 'starting', pid: null, version: installed.version });
    // A MediaMTX nobody recorded (one whose agent was killed before it could record it, or another altogether) would
    // keep this one from binding, and answer its readiness checks instead. Refuse rather than drive it.
    if ((await this.api.version()) !== undefined) throw new Error(`Something else is answering on ${CONTROL.api}`);
    // Plain `spawn`, detached and unreferenced, so MediaMTX outlives the agent. It writes its log straight to the file
    // through a descriptor of its own; writing through pipes to the agent would keep the agent alive, and break
    // MediaMTX's output once it exits. It runs from the runtime's directory, not the install's, which is shared and
    // read-only: MediaMTX writes files of its own beside it, such as the certificate it generates for MoQ.
    const log = await open(this.log, 'a');
    const subprocess = spawn(installed.path, [this.config], {
      cwd: this.options.directory,
      detached: true,
      stdio: ['ignore', log.fd, log.fd]
    });
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
    if (pid === undefined) throw new Error('MediaMTX could not be started');
    try {
      // Recorded as soon as it runs: an agent killed from here on still leaves the next one a MediaMTX it can find.
      const record: ProcessRecord = { pid, install: installed.id };
      await writeFile(this.record, JSON.stringify(record));
      this.adopt(record);
      await this.api.ready(signal, () => !alive(pid));
      return pid;
    } catch (error) {
      // Half started: don't leave it behind.
      this.current = undefined;
      clearInterval(this.watching);
      await stopMediamtx(pid);
      await rm(this.record, { force: true });
      throw error;
    }
  }

  /** Watches `record`'s MediaMTX: checks every second that it is still alive, and starts it again if it has died. */
  private adopt(record: ProcessRecord): void {
    if (this.current?.pid === record.pid && this.watching !== undefined) return;
    this.current = record;
    clearInterval(this.watching);
    this.watching = setInterval(() => {
      if (this.current?.pid !== record.pid || alive(record.pid)) return;
      clearInterval(this.watching);
      this.watching = undefined;
      this.current = undefined;
      this.died(`process ${record.pid} died`);
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
      await this.serve(spec, AbortSignal.timeout(REVIVE_TIMEOUT_MS));
    });
    restarting.catch((error: Error) => {
      if (this.wanted !== spec || this.disposed) return;
      this.crashes++;
      this.update({ state: 'crashed', lastError: describe(error) });
      this.restart = setTimeout(() => this.revive(spec), restartDelay(this.crashes));
    });
  }

  /** Ships MediaMTX's metrics every `intervalMs` from now on; a direct agent has nothing to ship them to. */
  private ship(intervalMs: number): void {
    if (this.reporter === undefined) return;
    if (this.shipping !== undefined && this.status$.getValue().metrics?.intervalMs === intervalMs) return;
    clearInterval(this.shipping);
    this.shipping = setInterval(() => void this.tick(), intervalMs);
    this.shipping.unref();
    this.updateMetrics({ intervalMs });
  }

  private stopShipping(): void {
    clearInterval(this.shipping);
    this.shipping = undefined;
  }

  /** Reads MediaMTX's metrics while it should be running, queues them with `mediamtx.up`, and submits what's pending. */
  private async tick(): Promise<void> {
    const reporter = this.reporter;
    if (this.ticking || reporter === undefined || this.wanted === undefined) return;
    this.ticking = true;
    try {
      const now = new Date();
      const observedAt = now.toISOString();
      const metrics = await this.scrape(observedAt);
      const up = metrics === undefined ? 0 : 1;
      const upMetric: Metric = { name: 'mediamtx.up', type: 'gauge', value: up, unit: null, dimensions: {} };
      const payloads = [upMetric, ...(metrics ?? [])];
      reporter.queue(payloads.map(payload => ({ observedAt, payload })));
      await reporter.submit();
    } finally {
      this.ticking = false;
    }
  }

  /** MediaMTX's metrics, or `undefined` if it isn't running or didn't answer. */
  private async scrape(observedAt: string): Promise<Metric[] | undefined> {
    if (this.status$.getValue().state !== 'running') return undefined;
    try {
      const metrics = await scrape(CONTROL.metrics, AbortSignal.timeout(10_000));
      this.updateMetrics({ lastScrapedAt: observedAt, lastScrapeError: null });
      return metrics;
    } catch (error) {
      this.updateMetrics({ lastScrapeError: describe(error) });
      return undefined;
    }
  }

  private updateMetrics(change: Partial<MediamtxMetricsStatus>): void {
    const { metrics } = this.status$.getValue();
    if (metrics === null) return;
    this.update({ metrics: { ...metrics, ...change } });
  }

  private update(change: Partial<MediamtxStatus>): void {
    if (this.disposed || this.status$.closed) return;
    this.status$.next({ ...this.status$.getValue(), ...change });
  }
}

function stopped(metrics: MediamtxMetricsStatus | null): MediamtxStatus {
  return {
    state: 'stopped',
    pid: null,
    version: null,
    installing: false,
    restarts: 0,
    lastError: null,
    diagnostics: [],
    metrics
  };
}
