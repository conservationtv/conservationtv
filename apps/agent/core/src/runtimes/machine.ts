import { statfs } from 'node:fs/promises';
import os from 'node:os';
import { BehaviorSubject } from 'rxjs';
import { z } from 'zod';
import {
  MAX_BATCH_REPORTS,
  type Metric,
  MetricReporter,
  NOT_REPORTED,
  type ReportingStatus,
  type StudioConnection
} from '../reporting.ts';

// Machine metrics: on an interval, sample the machine the agent runs on and submit the samples to the studio API as
// metrics about the agent's device (src/reporting.ts). A submission that fails is kept and retried with the next,
// oldest dropped first beyond one batch.

/** What the machine metrics runtime should do. */
export const MachineSpecSchema = z.object({
  /** How often to sample and submit. */
  intervalMs: z.number().int().min(1_000)
});
export type MachineSpec = z.output<typeof MachineSpecSchema>;

/** A store's capacity and what is left of it, in bytes. */
export interface Capacity {
  total: number;
  free: number;
}

/** One sample of the machine. Byte counts are bytes; utilisation is a percentage of every core. */
export interface MachineSample {
  /** ISO 8601. */
  observedAt: string;
  /** Busy time across every core since the previous sample; `null` for the first, which has nothing to compare. */
  cpuUtilisation: number | null;
  cpuCount: number;
  /**
   * The kernel's 1-minute load average. Its 5- and 15-minute averages are not reported: sampled about once a minute,
   * this one is a record of load that longer windows can be computed from when it is read.
   */
  load: number;
  memory: Capacity;
  /** The filesystem the agent's working directory is on; `null` when it cannot be read. */
  disk: Capacity | null;
  uptimeSeconds: number;
  /** The agent's own resident memory. */
  agentRss: number;
}

export interface MachineStatus extends ReportingStatus {
  /** Whether a spec is applied and the machine is being sampled. */
  running: boolean;
  intervalMs: number | null;
  latest: MachineSample | null;
}

const STOPPED: MachineStatus = { running: false, intervalMs: null, latest: null, ...NOT_REPORTED };

/** Every core's busy and total time so far, in milliseconds. */
function cpuTimes() {
  let busy = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    const { user, nice, sys, idle, irq } = cpu.times;
    busy += user + nice + sys + irq;
    total += user + nice + sys + idle + irq;
  }
  return { busy, total };
}

type CpuTimes = ReturnType<typeof cpuTimes>;

async function diskUsage(): Promise<Capacity | null> {
  try {
    const stats = await statfs(process.cwd());
    return { total: stats.blocks * stats.bsize, free: stats.bavail * stats.bsize };
  } catch {
    return null;
  }
}

/** The sample's metrics, as the studio API takes them. */
function metricsOf(sample: MachineSample): Metric[] {
  const gauge = (name: string, value: number, unit: string, dimensions: Record<string, string> = {}): Metric => ({
    name,
    type: 'gauge',
    value,
    unit,
    dimensions
  });
  const metrics = [
    gauge('machine.cpu.count', sample.cpuCount, 'cores'),
    gauge('machine.load', sample.load, 'processes', { window: '1m' }),
    gauge('machine.memory.total', sample.memory.total, 'bytes'),
    gauge('machine.memory.free', sample.memory.free, 'bytes'),
    gauge('machine.uptime', sample.uptimeSeconds, 'seconds'),
    gauge('agent.memory.rss', sample.agentRss, 'bytes')
  ];
  if (sample.cpuUtilisation !== null) metrics.push(gauge('machine.cpu.utilisation', sample.cpuUtilisation, 'percent'));
  if (sample.disk !== null) {
    metrics.push(gauge('machine.disk.total', sample.disk.total, 'bytes'));
    metrics.push(gauge('machine.disk.free', sample.disk.free, 'bytes'));
  }
  return metrics;
}

/** Samples the machine on an interval, and submits each sample to the studio API as metrics about the agent's device. */
export class MachineRuntime {
  readonly status$ = new BehaviorSubject<MachineStatus>(STOPPED);
  private timer: ReturnType<typeof setInterval> | undefined = undefined;
  private readonly reporter: MetricReporter | undefined;
  private previousCpu: CpuTimes | undefined = undefined;
  /** Whether a tick is under way: a slow submission skips the ticks it overlaps rather than piling up. */
  private ticking = false;

  /** `studio` is `undefined` for a direct agent, which has nothing to report to. */
  constructor(studio: StudioConnection | undefined) {
    const options = { capacity: MAX_BATCH_REPORTS, onChange: (status: ReportingStatus) => this.update(status) };
    this.reporter = studio === undefined ? undefined : new MetricReporter(studio, options);
  }

  /** Sample at `spec`'s interval from now on. Accepted as soon as the timer is set; the studio API is asked later. */
  async apply(spec: MachineSpec): Promise<void> {
    if (this.reporter === undefined) throw new Error('A direct agent has no studio API to report to');
    this.clear();
    this.previousCpu = cpuTimes();
    const current = this.status$.getValue();
    this.status$.next({ ...current, running: true, intervalMs: spec.intervalMs });
    this.timer = setInterval(() => void this.tick(), spec.intervalMs);
  }

  /** Stop sampling, and drop what was not submitted. Safe when it never started. */
  async teardown(): Promise<void> {
    this.clear();
    this.reporter?.clear();
    this.update({ running: false, intervalMs: null });
  }

  /** Stop the timer for good when the agent stops; not a removal, so the status is left as it was. */
  dispose(): void {
    this.clear();
    this.status$.complete();
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const sample = await this.sample();
      const metrics = metricsOf(sample);
      this.reporter?.queue(metrics.map(payload => ({ observedAt: sample.observedAt, payload })));
      this.update({ latest: sample });
      await this.reporter?.submit();
    } finally {
      this.ticking = false;
    }
  }

  private async sample(): Promise<MachineSample> {
    const cpu = cpuTimes();
    const previous = this.previousCpu;
    this.previousCpu = cpu;
    const elapsed = previous === undefined ? 0 : cpu.total - previous.total;
    const cpuUtilisation = previous === undefined || elapsed <= 0 ? null : ((cpu.busy - previous.busy) / elapsed) * 100;
    const [load] = os.loadavg();
    const disk = await diskUsage();
    const memory = process.memoryUsage();
    const now = new Date();
    return {
      observedAt: now.toISOString(),
      cpuUtilisation,
      cpuCount: os.availableParallelism(),
      load: load!,
      memory: { total: os.totalmem(), free: os.freemem() },
      disk,
      uptimeSeconds: os.uptime(),
      agentRss: memory.rss
    };
  }

  private update(change: Partial<MachineStatus>) {
    if (this.status$.closed) return;
    const current = this.status$.getValue();
    this.status$.next({ ...current, ...change });
  }

  private clear(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
