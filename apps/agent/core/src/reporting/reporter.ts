import { deviceSubject, summarise, type MetricDefinition } from '@conservationtv/reports';
import type { Client, PostReportsData } from '@conservationtv/studio-sdk';
import { createStore } from '@conservationtv/store';
import type { AgentConfiguration } from '../config.ts';
import { useStudio } from '../studio.ts';

// Metric reports to the studio API (`reports.submit`), signed as the agent's device, and about it, `device:<id>`,
// unless queued about another subject, such as an exposure. The agent knows only its key, so it asks the studio API
// who it is (`whoami.get`) before its first submission, and again until it gets an answer.
//
// The agent has one reporter, which asks that once for all of its monitors, and each monitor a queue of its own from
// it (`MetricReporter.queue`). A queue is submitted, counted and dropped on its own schedule, so one monitor stopping
// never drops another's metrics, and what a monitor says is pending, or was accepted, is only its own.
//
// A submission that fails is kept and retried with the next, oldest dropped first beyond one batch. The API does not
// deduplicate, so a submission that failed after being stored may be stored twice: these are cheap operational
// signals, and losing a gap is worse.

type Report = PostReportsData['body']['reports'][number];
type MetricReport = Extract<Report, Record<'kind', 'metric'>>;
/** One metric, as the studio API takes it. */
export type Metric = MetricReport['payload'];

/** A metric queued but not yet accepted. Without a subject it is about the device, known on submission. */
interface PendingMetric {
  observedAt: string;
  subjectId: string | undefined;
  payload: Metric;
}

/** The studio API, signed as the agent's device, and the subject that device reports about itself as. */
interface Studio {
  client: Client;
  subjectId: string;
}

/** What a submission achieved. */
export interface Submission {
  accepted: number;
  /** ISO 8601. */
  submittedAt: string;
}

/** The most reports one submission carries, as the studio API accepts. */
const MAX_BATCH_REPORTS = 1000;

/** One sample of a metric from the catalogue. */
export function gauge(metric: MetricDefinition, value: number, dimensions: Record<string, string> = {}): Metric {
  return { name: metric.name, value, unit: metric.unit, dimensions };
}

/** The samples of a metric from the catalogue taken over an interval, summarised as one point. */
export function summary(metric: MetricDefinition, samples: number[], dimensions: Record<string, string> = {}): Metric {
  return { name: metric.name, summary: summarise(samples), unit: metric.unit, dimensions };
}

/** Submits the agent's metrics to the studio API, as its device, from each monitor's queue. */
export class MetricReporter {
  private studio: Studio | undefined = undefined;
  /** The ask for the device under way, which every submission meanwhile waits on. */
  private asking: Promise<Studio> | undefined = undefined;

  constructor(private readonly config: AgentConfiguration) {}

  /** The subject the reports are about, once the studio API has said which device the agent is. */
  get subjectId(): string | null {
    return this.studio?.subjectId ?? null;
  }

  /** A queue of a monitor's own, submitted with this reporter's device. */
  queue(): MetricQueue {
    return new MetricQueue(this);
  }

  /** Submit `metrics`, returning what the studio API accepted. Throws if that fails. */
  async submit(metrics: PendingMetric[]): Promise<Submission> {
    const studio = await this.connect();
    const reports = metrics.map(({ observedAt, subjectId, payload }): Report => ({
      kind: 'metric',
      subjectId: subjectId ?? studio.subjectId,
      observedAt,
      payload
    }));
    const result = await studio.client.reports.submit.v1({ reports });
    if (result instanceof Error) throw result;
    const now = new Date();
    return { accepted: result.accepted, submittedAt: now.toISOString() };
  }

  /** The studio API and the agent's device, asked for once, by whichever monitor submits first, and kept. */
  private async connect(): Promise<Studio> {
    if (this.studio !== undefined) return this.studio;
    // Monitors submitting meanwhile wait on the same ask; one that fails is asked again by the next submission.
    if (this.asking === undefined) this.asking = this.ask();
    try {
      return await this.asking;
    } finally {
      this.asking = undefined;
    }
  }

  /** Who the agent's device is, as the studio API says. */
  private async ask(): Promise<Studio> {
    const config = this.config;
    if (config.type === 'direct') throw new Error('A direct agent has no studio API to report to');
    const client = useStudio();
    await client.handshake();
    const device = await client.whoami.get.v1();
    if (device instanceof Error) throw device;
    const subjectId = deviceSubject(device.id);
    this.studio = { client, subjectId };
    return this.studio;
  }
}

/** One monitor's metrics, queued, and submitted through the agent's reporter in batches. */
export class MetricQueue {
  private pending: PendingMetric[] = [];

  constructor(private readonly reporter: MetricReporter) {}

  /** Metrics queued but not yet accepted. */
  get queued(): number {
    return this.pending.length;
  }

  /**
   * Queue `metrics`, all observed at once and about `subjectId`, or the device without one. Drops the oldest beyond
   * what one submission carries.
   */
  queue(observedAt: string, metrics: Metric[], subjectId?: string): void {
    const queued = metrics.map(payload => ({ observedAt, subjectId, payload }));
    this.pending = [...this.pending, ...queued].slice(-MAX_BATCH_REPORTS);
  }

  /** Submit every pending metric. Throws if that fails, keeping them for the next time. */
  async submit(): Promise<Submission> {
    const sent = new Set(this.pending);
    const submission = await this.reporter.submit([...sent]);
    // Keep only what was queued meanwhile; a clear meanwhile has dropped everything already.
    this.pending = this.pending.filter(metric => !sent.has(metric));
    return submission;
  }

  /** Drop what was not submitted. */
  clear(): void {
    this.pending = [];
  }
}

/** The agent's reporter. The agent supplies it on start; its monitors take their queues with `useMetricReporter()`. */
export const [withMetricReporter, useMetricReporter] = createStore<MetricReporter>('reports');
