import { statfs } from 'node:fs/promises';
import os from 'node:os';
import { BehaviorSubject } from 'rxjs';
import { z } from 'zod';
import type { AgentConfiguration } from '../config.ts';
import { type Metric, MetricReporter, gauge } from './reports.ts';

// Machine metrics: on an interval, sample the machine the agent runs on and submit the samples to the studio API as
// metrics about the agent's device (see reports.ts).

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

export interface MachineStatus {
  /** Whether a spec is applied and the machine is being sampled. */
  running: boolean;
  intervalMs: number | null;
  /** The subject the reports are about, once the studio API has said which device the agent is. */
  subjectId: string | null;
  latest: MachineSample | null;
  /** Reports sampled but not yet accepted. */
  pending: number;
  /** Reports accepted since the agent started; carried across spec changes. */
  submitted: number;
  /** ISO 8601. */
  lastSubmittedAt: string | null;
  /** Why the last attempt to identify or submit failed; cleared by the next success. */
  lastError: string | null;
}

const STOPPED: MachineStatus = {
  running: false,
  intervalMs: null,
  subjectId: null,
  latest: null,
  pending: 0,
  submitted: 0,
  lastSubmittedAt: null,
  lastError: null
};

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
  private readonly reporter: MetricReporter;
  private timer: ReturnType<typeof setInterval> | undefined = undefined;
  private previousCpu: CpuTimes | undefined = undefined;
  /** Whether a tick is under way: a slow submission skips the ticks it overlaps rather than piling up. */
  private ticking = false;

  constructor(private readonly config: AgentConfiguration) {
    this.reporter = new MetricReporter(config);
  }

  /** Sample at `spec`'s interval from now on. Accepted as soon as the timer is set; the studio API is asked later. */
  async apply(spec: MachineSpec): Promise<void> {
    if (this.config.type === 'direct') throw new Error('A direct agent has no studio API to report to');
    this.clear();
    this.previousCpu = cpuTimes();
    const current = this.status$.getValue();
    this.status$.next({ ...current, running: true, intervalMs: spec.intervalMs });
    this.timer = setInterval(() => void this.tick(), spec.intervalMs);
  }

  /** Stop sampling, and drop what was not submitted. Safe when it never started. */
  async teardown(): Promise<void> {
    this.clear();
    this.reporter.clear();
    const current = this.status$.getValue();
    this.status$.next({ ...current, running: false, intervalMs: null, pending: 0 });
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
      this.reporter.queue(sample.observedAt, metricsOf(sample));
      this.update({ latest: sample });
      await this.submit();
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

  /** Submit every pending report, keeping them for the next tick if that fails. */
  private async submit() {
    try {
      const { accepted, submittedAt } = await this.reporter.submit();
      const current = this.status$.getValue();
      this.update({ submitted: current.submitted + accepted, lastSubmittedAt: submittedAt, lastError: null });
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.update({ lastError: failure.message });
    }
  }

  private update(change: Partial<MachineStatus>) {
    if (this.status$.closed) return;
    const current = this.status$.getValue();
    const { reporter } = this;
    this.status$.next({ ...current, ...change, subjectId: reporter.subjectId, pending: reporter.queued });
  }

  private clear(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
