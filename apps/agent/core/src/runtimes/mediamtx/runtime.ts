import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BinaryStore, type Installed } from '@conservationtv/converge/binaries';
import { AdoptedProcess, type ProcessStatus, STOPPED as PROCESS_STOPPED } from '@conservationtv/converge/process';
import { BehaviorSubject, type Subscription } from 'rxjs';
import { z } from 'zod';
import type { AgentConfiguration } from '../../config.ts';
import { MetricReporter } from '../reports.ts';
import { mediamtxBinary } from './binary.ts';
import { MediamtxAuthSchema, MediamtxAuthServer } from './auth.ts';
import { type MediamtxAddresses, MoqPublisherSchema, renderConfig } from './config.ts';
import { MediamtxControl } from './control.ts';
import { BroadcastJoiner } from './joiner.ts';
import { METRICS_STOPPED, MediamtxMetrics, type MediamtxMetricsStatus } from './metrics.ts';
import { moqBinary } from './moq.ts';
import { MediamtxPathsSchema, pathIndexOf } from './paths.ts';

/** Which MediaMTX to run, the paths it serves, how it admits readers, and how often to ship its metrics. */
export const MediamtxSpecSchema = z.object({
  binary: mediamtxBinary.schema,
  /** The paths to serve, each delivering an exposure. None, without `auth`, serves any path, about the agent's device. */
  paths: MediamtxPathsSchema.default([]),
  /** Admit readers and publishers on this machine, and others only by tokens the studio API signs for this gateway; without it, anyone. */
  auth: MediamtxAuthSchema.optional(),
  /** Exposures to publish to MoQ relays from what this MediaMTX serves: each rendition run by MediaMTX, joined by the agent. */
  publishers: z.array(MoqPublisherSchema).default([]),
  /** The moq CLI the publishers run, installed beside MediaMTX while there are any. */
  moq: moqBinary.schema.optional(),
  /** How often to read MediaMTX's metrics page and submit what it says. */
  metricsIntervalMs: z.number().int().min(1_000)
});
export type MediamtxSpec = z.output<typeof MediamtxSpecSchema>;

/** The room the runtime is given to run MediaMTX in. */
export interface MediamtxRuntimeOptions extends MediamtxAddresses {
  /** A directory of its own: vendored binaries under `binaries/`, and MediaMTX's config, pidfile and log. */
  directory: string;
}

export interface MediamtxStatus extends ProcessStatus {
  /** The version of MediaMTX running, or being started. */
  version: string | null;
  /** Whether a binary is being downloaded and checked. */
  installing: boolean;
  metrics: MediamtxMetricsStatus;
}

const STOPPED: MediamtxStatus = { ...PROCESS_STOPPED, version: null, installing: false, metrics: METRICS_STOPPED };

/**
 * MediaMTX as a process of its own, outliving the agent, from a binary the runtime vendors itself. The spec names a
 * version, with a download and a checksum for each platform; the runtime installs it into its own directory, writes
 * the config beside it and has `AdoptedProcess` run it for that install: a MediaMTX left by an earlier agent is
 * adopted if it came from the install the spec now names, and replaced otherwise, so a changed config is a reload
 * in place while a changed version replaces the process. Only removing the key, through `finalize`, stops MediaMTX.
 *
 * Beside it, in the agent: the answers to MediaMTX's authentication requests (auth.ts), and the joined broadcast of
 * each exposure it publishes (joiner.ts). Both stop with the agent, while MediaMTX goes on.
 */
export class MediamtxRuntime {
  readonly status$ = new BehaviorSubject<MediamtxStatus>(STOPPED);
  private readonly binaries: BinaryStore;
  private readonly process: AdoptedProcess;
  private readonly metrics: MediamtxMetrics;
  private readonly watching: Subscription[];
  private readonly configFile: string;
  private readonly authServer: MediamtxAuthServer;
  private readonly joiner = new BroadcastJoiner();

  constructor(
    private readonly config: AgentConfiguration,
    private readonly options: MediamtxRuntimeOptions
  ) {
    this.binaries = new BinaryStore({ directory: join(options.directory, 'binaries') });
    const control = new MediamtxControl(options.api);
    this.process = new AdoptedProcess(options.directory, { name: 'mediamtx', probe: signal => control.alive(signal) });
    this.metrics = new MediamtxMetrics(options.metrics, new MetricReporter(config));
    this.watching = [
      this.process.status$.subscribe(status => this.update(status)),
      this.metrics.status$.subscribe(metrics => this.update({ metrics }))
    ];
    this.configFile = join(options.directory, 'mediamtx.yml');
    this.authServer = new MediamtxAuthServer(options.authHttp);
  }

  /**
   * Installs the binary the spec names if need be, answers its authentication requests, has a MediaMTX from it serving
   * the config, then joins its publishers' broadcasts and ships its metrics. Resolves once MediaMTX is serving.
   */
  async execute(spec: MediamtxSpec, signal: AbortSignal): Promise<void> {
    const installed = (await this.binaries.find(spec.binary)) ?? (await this.install(spec, signal));
    this.update({ version: installed.version });
    const moq = await this.installMoq(spec, signal);
    if (spec.auth === undefined) await this.authServer.close();
    else await this.authServer.serve(spec.auth);
    await this.writeConfig(spec, moq);
    // From the same spec as the config, so the metrics follow each path to the exposure it now delivers.
    this.metrics.attribute(pathIndexOf(spec.paths));
    const { directory } = this.options;
    await this.process.ensure(
      { key: installed.id, binary: installed.path, args: [this.configFile], cwd: directory },
      signal
    );
    this.joiner.apply(spec.publishers);
    // A direct agent has no studio API to ship to.
    if (this.config.type !== 'direct') this.metrics.start(spec.metricsIntervalMs);
    await this.binaries.prune(installed, { spare: 1 });
    if (moq !== undefined) await this.binaries.prune(moq, { spare: 1 });
  }

  /** The moq CLI, installed if the spec has publishers for it to run. */
  private async installMoq(spec: MediamtxSpec, signal: AbortSignal): Promise<Installed | undefined> {
    if (spec.publishers.length === 0) return undefined;
    if (spec.moq === undefined) throw new Error('The spec has publishers, but no moq CLI for them to run');
    return (await this.binaries.find(spec.moq)) ?? (await this.binaries.install(moqBinary, spec.moq, signal));
  }

  /**
   * Stops MediaMTX, whichever binary it came from, including one left running by an earlier agent. Then removes the
   * vendored binaries too: removing the key removes everything it put there.
   */
  async finalize(): Promise<void> {
    this.metrics.stop();
    this.joiner.close();
    await this.process.stop();
    await this.authServer.close();
    await this.binaries.clear();
    this.update({ version: null });
  }

  /**
   * The agent is stopping. MediaMTX is left running for the next agent to adopt; the watching, joining and answering
   * stop, so until then MediaMTX admits no one and its publishers' broadcasts go unjoined.
   */
  dispose(): void {
    for (const subscription of this.watching) subscription.unsubscribe();
    this.joiner.close();
    void this.authServer.close();
    this.metrics.dispose();
    this.process.dispose();
    this.status$.complete();
  }

  /** Downloads and checks the binary the spec names, which the status reports while it lasts. */
  private install(spec: MediamtxSpec, signal: AbortSignal): Promise<Installed> {
    this.update({ installing: true });
    return this.binaries.install(mediamtxBinary, spec.binary, signal).finally(() => this.update({ installing: false }));
  }

  /**
   * Writes the config before MediaMTX reads it, or re-reads it: a running MediaMTX reloads its file whenever it is
   * written, so one already serving this config is left undisturbed.
   */
  private async writeConfig(spec: MediamtxSpec, moq: Installed | undefined): Promise<void> {
    await mkdir(this.options.directory, { recursive: true });
    const { paths, auth, publishers } = spec;
    const publishing = moq === undefined ? undefined : { moq: moq.path, publishers };
    const config = await renderConfig({ ...this.options, paths, auth, publishing });
    const written = await readFile(this.configFile, 'utf8').catch(() => undefined);
    if (written !== config) await writeFile(this.configFile, config);
  }

  private update(change: Partial<MediamtxStatus>): void {
    if (this.status$.closed) return;
    const current = this.status$.getValue();
    this.status$.next({ ...current, ...change });
  }
}
