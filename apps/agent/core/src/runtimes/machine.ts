import { statfs } from 'node:fs/promises';
import os from 'node:os';
import { Client, DeviceIdentity, deviceSignature, type PostReportsData } from '@conservationtv/studio-sdk';
import { BehaviorSubject } from 'rxjs';
import { z } from 'zod';
import type { AgentConfiguration } from '../config.ts';

// Machine metrics: on an interval, sample the machine the agent runs on and submit the samples to the studio API
// (`reports.submit`), signed as the agent's device and about it, `device:<id>`. The agent knows only its key, so it
// asks the studio API who it is (`whoami.get`) before its first submission, and again until it gets an answer.
//
// A submission that fails is kept and retried with the next, oldest dropped first beyond one batch. The API does not
// deduplicate, so a submission that failed after being stored may be stored twice: these are cheap operational
// signals, and losing a gap is worse.

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

type Report = PostReportsData['body']['reports'][number];
type MetricReport = Extract<Report, Record<'kind', 'metric'>>;
type Metric = MetricReport['payload'];

/** A metric sampled but not yet accepted. Its subject is added on submission, once the device is known. */
interface PendingMetric {
  observedAt: string;
  payload: Metric;
}

/** The most reports one submission carries, as the studio API accepts. */
const MAX_BATCH_REPORTS = 1000;

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

/** The studio API, signed as the agent's device, and the subject that device reports about itself as. */
interface Studio {
  client: Client;
  subjectId: string;
}

/** Samples the machine on an interval, and submits each sample to the studio API as metrics about the agent's device. */
export class MachineRuntime {
  readonly status$ = new BehaviorSubject<MachineStatus>(STOPPED);
  private timer: ReturnType<typeof setInterval> | undefined = undefined;
  private studio: Studio | undefined = undefined;
  private previousCpu: CpuTimes | undefined = undefined;
  private pending: PendingMetric[] = [];
  /** Whether a tick is under way: a slow submission skips the ticks it overlaps rather than piling up. */
  private ticking = false;

  constructor(private readonly config: AgentConfiguration) {}

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
    this.pending = [];
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
      this.queue(sample);
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

  /** Queue the sample's metrics, dropping the oldest beyond what one submission carries. */
  private queue(sample: MachineSample) {
    const metrics = metricsOf(sample);
    const queued = metrics.map(payload => ({ observedAt: sample.observedAt, payload }));
    this.pending = [...this.pending, ...queued].slice(-MAX_BATCH_REPORTS);
  }

  /** Submit every pending report, keeping them for the next tick if that fails. */
  private async submit() {
    const sent = new Set(this.pending);
    try {
      const studio = await this.connect();
      const reports = Array.from(sent, ({ observedAt, payload }): Report => ({
        kind: 'metric',
        subjectId: studio.subjectId,
        observedAt,
        payload
      }));
      const result = await studio.client.reports.submit.v1({ reports });
      if (result instanceof Error) throw result;
      // Keep only what was queued meanwhile; a teardown meanwhile has dropped everything already.
      this.pending = this.pending.filter(metric => !sent.has(metric));
      const current = this.status$.getValue();
      const now = new Date();
      this.update({
        submitted: current.submitted + result.accepted,
        lastSubmittedAt: now.toISOString(),
        lastError: null
      });
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.update({ lastError: failure.message });
    }
  }

  /** The studio API and the agent's device, asked for once and kept. */
  private async connect(): Promise<Studio> {
    if (this.studio !== undefined) return this.studio;
    const config = this.config;
    if (config.type === 'direct') throw new Error('A direct agent has no studio API to report to');
    const identity = await DeviceIdentity.fromSecretKey(config.secretKey);
    const client = new Client({ baseUrl: config.studioUrl, auth: deviceSignature(identity) });
    await client.handshake();
    const device = await client.whoami.get.v1();
    if (device instanceof Error) throw device;
    const subjectId = `device:${device.id}`;
    this.studio = { client, subjectId };
    this.update({ subjectId });
    return this.studio;
  }

  private update(change: Partial<MachineStatus>) {
    if (this.status$.closed) return;
    const current = this.status$.getValue();
    this.status$.next({ ...current, ...change, pending: this.pending.length });
  }

  private clear(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
