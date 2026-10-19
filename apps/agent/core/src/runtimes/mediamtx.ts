import { type ChildProcess, spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { BinaryStore, type Installed, defineBinary, reportsVersion } from '@conservationtv/converge/binaries';
import { MediamtxConfigBuilder, pipeline, toYaml } from '@conservationtv/mediamtx';
import { BehaviorSubject } from 'rxjs';
import { z } from 'zod';
import type { AgentConfiguration } from '../config.ts';
import { type Metric, MetricReporter } from './reporter.ts';

// MediaMTX, vendored and run by the agent. The spec names the release; the runtime installs it into its own
// directory, writes MediaMTX's config, and runs it as a child of the agent, starting it again after a backoff if it
// dies. For now the config is fixed: every path accepted, and metrics on loopback.
//
// On an interval, MediaMTX's Prometheus metrics are scraped and submitted to the studio API through a
// `MetricReporter`, as `mediamtx.<name>` about the agent's device, with each metric's labels as its dimensions.

/** MediaMTX's releases: a tarball (a zip for Windows) per platform, and `mediamtx --version` prints `v1.21.2`. */
export const mediamtxBinary = defineBinary({ name: 'mediamtx', checks: [reportsVersion()] });

/** Which MediaMTX to run, and how often to submit its metrics. */
export const MediamtxSpecSchema = z.object({
  mediamtx: mediamtxBinary.schema,
  /** How often to scrape and submit. */
  metricsIntervalMs: z.number().int().min(1_000)
});
export type MediamtxSpec = z.output<typeof MediamtxSpecSchema>;

const release = 'https://github.com/bluenviron/mediamtx/releases/download/v1.21.2';

/** MediaMTX v1.21.2, with the checksums from the release's `checksums.sha256`. */
export const DEFAULT_MEDIAMTX_SPEC: MediamtxSpec = {
  mediamtx: {
    name: 'mediamtx',
    version: '1.21.2',
    artifacts: {
      'darwin-arm64': {
        url: `${release}/mediamtx_v1.21.2_darwin_arm64.tar.gz`,
        checksum: 'sha256:7d0d0c5c11527cbd10bde1c3d728864eb0334a9b653566cd73c0259750cbf093',
        format: 'tar'
      },
      'darwin-x64': {
        url: `${release}/mediamtx_v1.21.2_darwin_amd64.tar.gz`,
        checksum: 'sha256:87a00062b6a588aa1158f875504a3b56c80d62e2611dc450b83d0534e1b49198',
        format: 'tar'
      },
      'linux-arm64': {
        url: `${release}/mediamtx_v1.21.2_linux_arm64.tar.gz`,
        checksum: 'sha256:180a235374a548d9133cdd5e20f5dbd8b01317be1c86e0d7e66df585dc42ed6f',
        format: 'tar'
      },
      'linux-arm': {
        url: `${release}/mediamtx_v1.21.2_linux_armv7.tar.gz`,
        checksum: 'sha256:bff8951f51dcb0426c306fc3fad793232f03947916370b166d10e6c73dcf9ce2',
        format: 'tar'
      },
      'linux-x64': {
        url: `${release}/mediamtx_v1.21.2_linux_amd64.tar.gz`,
        checksum: 'sha256:121be6e00397e473a95d83c75f4fcd3819a6af3b0e1a50889cba43ab4fab6a27',
        format: 'tar'
      },
      'win32-x64': {
        url: `${release}/mediamtx_v1.21.2_windows_amd64.zip`,
        checksum: 'sha256:a84224f5a490855684e62ba6fb71e80ea2a5e16aed61883bb58380290e93e467',
        format: 'zip'
      }
    }
  },
  metricsIntervalMs: 60_000
};

export interface MediamtxStatus {
  state: 'stopped' | 'starting' | 'running' | 'crashed';
  pid: number | null;
  /** The version of MediaMTX running, or being started. */
  version: string | null;
  /** Whether a binary is being downloaded and checked. */
  installing: boolean;
  /** How many times it has been started again after it died. */
  restarts: number;
  /** Why it last died or failed to start. */
  lastError: string | null;
  /** Metrics scraped but not yet accepted. */
  pending: number;
  /** Metrics accepted since the agent started; carried across spec changes. */
  submitted: number;
  /** ISO 8601. */
  lastSubmittedAt: string | null;
  /** Why the last attempt to scrape or submit metrics failed; cleared by the next success. */
  lastMetricsError: string | null;
}

const STOPPED: MediamtxStatus = {
  state: 'stopped',
  pid: null,
  version: null,
  installing: false,
  restarts: 0,
  lastError: null,
  pending: 0,
  submitted: 0,
  lastSubmittedAt: null,
  lastMetricsError: null
};

/** Where MediaMTX serves its metrics: loopback only, for the agent to scrape. */
const METRICS_ADDRESS = '127.0.0.1:9998';

const READY_TIMEOUT_MS = 10_000;
const STOP_GRACE_MS = 5_000;
const RESTART_BASE_MS = 1_000;
const RESTART_MAX_MS = 30_000;

interface ObservabilityParams {
  /** Where MediaMTX serves its metrics. */
  metricsAddress: string;
}

/** Structured logs, and Prometheus metrics. The default users let localhost read them without credentials. */
const observability = new MediamtxConfigBuilder<ObservabilityParams>(({ metricsAddress }, config) => {
  config.logStructured = true;
  config.metrics = true;
  config.metricsAddress = metricsAddress;
});

/** Any stream may be published to, and read from, any path. */
const anyPath = new MediamtxConfigBuilder<unknown>((_params, config) => {
  config.paths.all_others = {};
});

const mediamtxConfig = pipeline(observability, anyPath);

/** The config MediaMTX runs with, as mediamtx.yml. Throws if a step or the schema found an error. */
async function renderConfig(): Promise<string> {
  const { config, diagnostics } = await mediamtxConfig.render({ metricsAddress: METRICS_ADDRESS });
  const errors = diagnostics.filter(diagnostic => diagnostic.severity === 'error');
  if (errors.length > 0) throw new Error(`MediaMTX config: ${errors.map(error => error.message).join('; ')}`);
  return toYaml(config);
}

/** One sample in Prometheus' text format: `name{label="value",…} value [timestamp]`. */
const SAMPLE = /^([a-zA-Z_:][\w:]*)(?:\{(.*)\})?\s+(\S+)(?:\s+-?\d+)?$/;
const LABEL = /(\w+)="((?:[^"\\]|\\.)*)"/g;
// MediaMTX gives no `# TYPE` lines or units, so both come from the name. Counts of bytes, packets and frames are
// totals, apart from levels (buffers, windows) and what is derived from them (rates, times, jitter).
const UNIT = /(?:^|_)(bytes|packets|frames|mbps|ms|us)(?:_|$)/;
const COUNTED = new Set(['bytes', 'packets', 'frames']);
const LEVEL = /_(buf|size|window|mss|tolerance|period)$/;
const DERIVED = /_(rate|time|jitter)$/;

/** A sample's labels, unescaped. */
function dimensionsOf(labels: string) {
  const unescape = (quoted: string) =>
    quoted.replace(/\\(.)/g, (_escape, char: string) => (char === 'n' ? '\n' : char));
  return Object.fromEntries(Array.from(labels.matchAll(LABEL), ([, key, quoted]) => [key!, unescape(quoted!)]));
}

/** A metric's type and unit, from its name: the first unit named, unless the value is a rate or time derived from it. */
function kindOf(name: string): Pick<Metric, 'type' | 'unit'> {
  const unit = DERIVED.test(name) ? null : (UNIT.exec(name)?.[1] ?? null);
  const counter = unit !== null && COUNTED.has(unit) && !LEVEL.test(name);
  return { type: counter ? 'counter' : 'gauge', unit };
}

/** One sample line as a metric, or `undefined` if it isn't one. */
function metricOf(line: string): Metric | undefined {
  const match = SAMPLE.exec(line);
  const value = Number(match?.[3]);
  if (match === null || !Number.isFinite(value)) return undefined;
  const name = match[1]!;
  const dimensions = dimensionsOf(match[2] ?? '');
  return { name: `mediamtx.${name}`, ...kindOf(name), value, dimensions };
}

/**
 * MediaMTX's metrics, as the studio API takes them. MediaMTX repeats some under older names, in sections it heads
 * "(deprecated)"; those are left out.
 */
export function parseMetrics(text: string): Metric[] {
  const metrics: Metric[] = [];
  let deprecated = false;
  for (const raw of text.split('\n')) {
    // Sections are separated by blank lines, and headed by comments: a deprecated one is skipped up to the next blank.
    const line = raw.trim();
    if (line === '') deprecated = false;
    else if (line.startsWith('#')) deprecated ||= line.includes('(deprecated)');
    else if (!deprecated) {
      const metric = metricOf(line);
      if (metric !== undefined) metrics.push(metric);
    }
  }
  return metrics;
}

/** How long to wait before starting MediaMTX again after it has died `crashes` times in a row. */
function restartDelay(crashes: number): number {
  return Math.min(RESTART_BASE_MS * 2 ** (crashes - 1), RESTART_MAX_MS);
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Runs MediaMTX as a child of the agent, and submits its metrics to the studio API. */
export class MediamtxRuntime {
  readonly status$ = new BehaviorSubject<MediamtxStatus>(STOPPED);
  private readonly directory: string;
  private readonly binaries: BinaryStore;
  private readonly reporter: MetricReporter;
  /** The install MediaMTX runs from, while it should be running. */
  private installed: Installed | undefined = undefined;
  private child: ChildProcess | undefined = undefined;
  private crashes = 0;
  private restart: ReturnType<typeof setTimeout> | undefined = undefined;
  private timer: ReturnType<typeof setInterval> | undefined = undefined;
  /** Whether a tick is under way: a slow submission skips the ticks it overlaps rather than piling up. */
  private ticking = false;

  constructor(config: AgentConfiguration) {
    this.directory = join(config.directory, 'mediamtx');
    this.binaries = new BinaryStore({ directory: join(this.directory, 'binaries') });
    this.reporter = new MetricReporter(config);
  }

  /** Installs the binary the spec names if need be, and runs MediaMTX from it. Resolves once it serves its metrics. */
  async execute(spec: MediamtxSpec, signal: AbortSignal): Promise<void> {
    this.update({ installing: true });
    const installed = await this.binaries
      .install(mediamtxBinary, spec.mediamtx, signal)
      .finally(() => this.update({ installing: false }));
    if (this.installed?.id !== installed.id || this.child === undefined) {
      await this.stop();
      this.installed = installed;
      this.crashes = 0;
      await this.start(signal);
    }
    this.clearTimer();
    this.timer = setInterval(() => void this.tick(), spec.metricsIntervalMs);
    await this.binaries.prune(installed, { spare: 1 });
  }

  /** Stops MediaMTX, drops the metrics not yet submitted, and removes everything the runtime put in its directory. */
  async finalize(): Promise<void> {
    this.clearTimer();
    this.reporter.clear();
    await this.stop();
    this.installed = undefined;
    await rm(this.directory, { recursive: true, force: true });
    const { restarts, submitted, lastSubmittedAt } = this.status$.getValue();
    this.update({ ...STOPPED, restarts, submitted, lastSubmittedAt });
  }

  /** The agent is stopping, and MediaMTX, its child, stops with it. */
  dispose(): void {
    this.clearTimer();
    clearTimeout(this.restart);
    const child = this.child;
    this.child = undefined;
    child?.kill();
    this.status$.complete();
  }

  /** Writes the config and starts MediaMTX from the current install, waiting until it serves its metrics. */
  private async start(signal: AbortSignal): Promise<void> {
    const installed = this.installed;
    if (installed === undefined) return;
    this.update({ state: 'starting', pid: null, version: installed.version });
    await mkdir(this.directory, { recursive: true });
    const config = join(this.directory, 'mediamtx.yml');
    await writeFile(config, await renderConfig());
    // Run from the runtime's directory, where MediaMTX writes what it generates (such as its MoQ certificate), never
    // from the install, which is shared and read-only. Its structured log goes to the agent's.
    const child = spawn(installed.path, [config], { cwd: this.directory, stdio: ['ignore', 'inherit', 'inherit'] });
    const started = new Promise<Error | undefined>(resolve => {
      child.once('spawn', () => resolve(undefined));
      child.once('error', resolve);
    });
    const failed = await started;
    if (failed !== undefined) throw failed;
    this.child = child;
    child.once('exit', (code, exitSignal) => this.exited(child, `exited with ${exitSignal ?? code}`));
    try {
      await this.ready(signal, () => child.exitCode !== null || child.signalCode !== null);
    } catch (error) {
      // Half started: don't leave it behind.
      await this.stop();
      throw error;
    }
    this.update({ state: 'running', pid: child.pid ?? null });
  }

  /** Waits until MediaMTX serves its metrics, giving up if `signal` aborts, it dies, or it takes too long. */
  private async ready(signal: AbortSignal, gone: () => boolean): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (
      !(await this.scrape().then(
        () => true,
        () => false
      ))
    ) {
      signal.throwIfAborted();
      if (gone()) throw new Error('MediaMTX exited before it was ready');
      if (Date.now() > deadline) throw new Error('MediaMTX did not serve its metrics in time');
      await delay(100, undefined, { signal });
    }
  }

  /** Stops MediaMTX if it is running: asks it to stop, then kills it if it hasn't within the grace period. */
  private async stop(): Promise<void> {
    clearTimeout(this.restart);
    const child = this.child;
    this.child = undefined;
    if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill();
    const timeout = delay(STOP_GRACE_MS).then(() => 'timeout');
    if ((await Promise.race([exited, timeout])) === 'timeout') child.kill('SIGKILL');
    await exited;
    this.update({ state: 'stopped', pid: null });
  }

  /** MediaMTX died without being asked to: start it again after a backoff. */
  private exited(child: ChildProcess, lastError: string): void {
    if (this.child !== child || this.status$.closed) return;
    this.child = undefined;
    this.crashes++;
    const { restarts } = this.status$.getValue();
    this.update({ state: 'crashed', pid: null, restarts: restarts + 1, lastError });
    this.restart = setTimeout(() => this.revive(), restartDelay(this.crashes));
  }

  private revive(): void {
    this.start(AbortSignal.timeout(READY_TIMEOUT_MS * 3)).then(
      () => (this.crashes = 0),
      (error: Error) => {
        if (this.status$.closed || this.installed === undefined || this.child !== undefined) return;
        this.crashes++;
        this.update({ state: 'crashed', lastError: describe(error) });
        this.restart = setTimeout(() => this.revive(), restartDelay(this.crashes));
      }
    );
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = new Date();
      const metrics = await this.scrape();
      this.reporter.queue(now.toISOString(), parseMetrics(metrics));
      const accepted = await this.reporter.submit();
      const current = this.status$.getValue();
      const submittedAt = new Date();
      this.update({
        submitted: current.submitted + accepted,
        lastSubmittedAt: submittedAt.toISOString(),
        lastMetricsError: null
      });
    } catch (error) {
      this.update({ lastMetricsError: describe(error) });
    } finally {
      this.ticking = false;
    }
  }

  /** MediaMTX's metrics, in Prometheus' text format. */
  private async scrape(): Promise<string> {
    const response = await fetch(`http://${METRICS_ADDRESS}/metrics`, { signal: AbortSignal.timeout(2_000) });
    if (!response.ok) throw new Error(`MediaMTX's metrics answered ${response.status}`);
    return response.text();
  }

  private update(change: Partial<MediamtxStatus>): void {
    if (this.status$.closed) return;
    const current = this.status$.getValue();
    this.status$.next({ ...current, ...change, pending: this.reporter.pending });
  }

  private clearTimer(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
