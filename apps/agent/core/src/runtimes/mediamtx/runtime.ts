import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { BinaryStore } from '@conservationtv/converge/binaries';
import { BehaviorSubject, type Observable, combineLatest, map } from 'rxjs';
import type { AgentConfiguration } from '../../config.ts';
import { writeConfig } from './config.ts';
import { MediamtxMetrics } from './metrics.ts';
import { MediamtxProcess, type ProcessStatus } from './process.ts';
import { mediamtxBinary } from './release.ts';
import { MetricShipper, type ShippingStatus } from './shipping.ts';
import type { MediamtxSpec } from './spec.ts';

// MediaMTX, vendored and run by the agent: the spec names the release, which is installed into the runtime's own
// directory and run with the config from `config.ts`; its metrics are scraped and submitted on the spec's interval.
// Each part reports its own status, and the runtime's is theirs side by side.

/** Which install is in use, and whether one is being downloaded and checked. */
export interface InstallStatus {
  /** The version of MediaMTX running, or being started. */
  version: string | null;
  installing: boolean;
}

export interface MediamtxStatus extends InstallStatus {
  process: ProcessStatus;
  metrics: ShippingStatus;
}

const NOT_INSTALLED: InstallStatus = { version: null, installing: false };

/** Where MediaMTX serves its metrics: loopback only, for the agent to scrape. */
const METRICS_ADDRESS = '127.0.0.1:9998';

export class MediamtxRuntime {
  readonly status$: Observable<MediamtxStatus>;
  private readonly install$ = new BehaviorSubject<InstallStatus>(NOT_INSTALLED);
  private readonly directory: string;
  private readonly binaries: BinaryStore;
  private readonly metrics = new MediamtxMetrics(METRICS_ADDRESS);
  private readonly process: MediamtxProcess;
  private readonly shipper: MetricShipper;

  constructor(config: AgentConfiguration) {
    this.directory = join(config.directory, 'mediamtx');
    this.binaries = new BinaryStore({ directory: join(this.directory, 'binaries') });
    this.process = new MediamtxProcess({ directory: this.directory, alive: () => this.metrics.alive() });
    this.shipper = new MetricShipper(config);
    this.status$ = combineLatest([this.install$, this.process.status$, this.shipper.status$]).pipe(
      map(([install, process, metrics]) => ({ ...install, process, metrics }))
    );
  }

  /** Installs the binary the spec names if need be, and runs MediaMTX from it. Resolves once it is up. */
  async execute(spec: MediamtxSpec, signal: AbortSignal): Promise<void> {
    this.updateInstall({ installing: true });
    const installed = await this.binaries
      .install(mediamtxBinary, spec.mediamtx, signal)
      .finally(() => this.updateInstall({ installing: false }));
    if (!this.process.runs(installed.path)) {
      const config = await writeConfig(this.directory, { metricsAddress: METRICS_ADDRESS });
      this.updateInstall({ version: installed.version });
      await this.process.start({ binary: installed.path, config }, signal);
    }
    this.shipper.every(spec.metricsIntervalMs, () => this.metrics.scrape());
    await this.binaries.prune(installed, { spare: 1 });
  }

  /** Stops MediaMTX, drops the metrics not yet submitted, and removes everything the runtime put in its directory. */
  async finalize(): Promise<void> {
    this.shipper.stop();
    await this.process.stop();
    await rm(this.directory, { recursive: true, force: true });
    this.updateInstall(NOT_INSTALLED);
  }

  /** The agent is stopping, and MediaMTX, its child, stops with it. */
  dispose(): void {
    this.shipper.dispose();
    this.process.dispose();
    this.install$.complete();
  }

  private updateInstall(change: Partial<InstallStatus>): void {
    if (this.install$.closed) return;
    this.install$.next({ ...this.install$.getValue(), ...change });
  }
}
