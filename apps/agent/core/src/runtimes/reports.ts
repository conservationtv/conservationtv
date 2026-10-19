import { Client, DeviceIdentity, deviceSignature, type PostReportsData } from '@conservationtv/studio-sdk';
import type { AgentConfiguration } from '../config.ts';

// Metric reports to the studio API (`reports.submit`), signed as the agent's device and about it, `device:<id>`. The
// agent knows only its key, so it asks the studio API who it is (`whoami.get`) before its first submission, and again
// until it gets an answer.
//
// A submission that fails is kept and retried with the next, oldest dropped first beyond one batch. The API does not
// deduplicate, so a submission that failed after being stored may be stored twice: these are cheap operational
// signals, and losing a gap is worse.

type Report = PostReportsData['body']['reports'][number];
type MetricReport = Extract<Report, Record<'kind', 'metric'>>;
/** One metric, as the studio API takes it. */
export type Metric = MetricReport['payload'];

/** A metric queued but not yet accepted. Its subject is added on submission, once the device is known. */
interface PendingMetric {
  observedAt: string;
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

export function gauge(name: string, value: number, unit: string, dimensions: Record<string, string> = {}): Metric {
  return { name, type: 'gauge', value, unit, dimensions };
}

/** Queues metrics about the agent's device, and submits them to the studio API in batches. */
export class MetricReporter {
  private studio: Studio | undefined = undefined;
  private pending: PendingMetric[] = [];

  constructor(private readonly config: AgentConfiguration) {}

  /** Metrics queued but not yet accepted. */
  get queued(): number {
    return this.pending.length;
  }

  /** The subject the reports are about, once the studio API has said which device the agent is. */
  get subjectId(): string | null {
    return this.studio?.subjectId ?? null;
  }

  /** Queue `metrics`, all observed at once, dropping the oldest beyond what one submission carries. */
  queue(observedAt: string, metrics: Metric[]): void {
    const queued = metrics.map(payload => ({ observedAt, payload }));
    this.pending = [...this.pending, ...queued].slice(-MAX_BATCH_REPORTS);
  }

  /** Submit every pending metric. Throws if that fails, keeping them for the next time. */
  async submit(): Promise<Submission> {
    const sent = new Set(this.pending);
    const studio = await this.connect();
    const reports = Array.from(sent, ({ observedAt, payload }): Report => ({
      kind: 'metric',
      subjectId: studio.subjectId,
      observedAt,
      payload
    }));
    const result = await studio.client.reports.submit.v1({ reports });
    if (result instanceof Error) throw result;
    // Keep only what was queued meanwhile; a clear meanwhile has dropped everything already.
    this.pending = this.pending.filter(metric => !sent.has(metric));
    const now = new Date();
    return { accepted: result.accepted, submittedAt: now.toISOString() };
  }

  /** Drop what was not submitted. */
  clear(): void {
    this.pending = [];
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
    return this.studio;
  }
}
