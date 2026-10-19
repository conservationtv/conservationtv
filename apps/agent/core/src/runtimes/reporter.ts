import { Client, DeviceIdentity, deviceSignature, type PostReportsData } from '@conservationtv/studio-sdk';
import type { AgentConfiguration } from '../config.ts';

// Metrics for the studio API (`reports.submit`), signed as the agent's device and about it, `device:<id>`. The agent
// knows only its key, so it asks the studio API who it is (`whoami.get`) before its first submission, and again until
// it gets an answer.
//
// A submission that fails is kept and retried with the next, oldest dropped first beyond one batch. The API does not
// deduplicate, so a submission that failed after being stored may be stored twice: these are cheap operational
// signals, and losing a gap is worse.

type Report = PostReportsData['body']['reports'][number];
type MetricReport = Extract<Report, Record<'kind', 'metric'>>;
export type Metric = MetricReport['payload'];

/** A metric queued but not yet accepted. Its subject is added on submission, once the device is known. */
interface PendingMetric {
  observedAt: string;
  payload: Metric;
}

/** The most reports one submission carries, as the studio API accepts. */
const MAX_BATCH_REPORTS = 1000;

/** The studio API, signed as the agent's device, and the subject that device reports about itself as. */
interface Studio {
  client: Client;
  subjectId: string;
}

/** Queues metrics about the agent's device, and submits them to the studio API. */
export class MetricReporter {
  private studio: Studio | undefined = undefined;
  private queued: PendingMetric[] = [];

  constructor(private readonly config: AgentConfiguration) {}

  /** The subject the reports are about, once the studio API has said which device the agent is. */
  get subjectId(): string | null {
    return this.studio?.subjectId ?? null;
  }

  /** Metrics queued but not yet accepted. */
  get pending(): number {
    return this.queued.length;
  }

  /** Queue metrics observed at `observedAt`, dropping the oldest beyond what one submission carries. */
  queue(observedAt: string, metrics: Metric[]): void {
    const queued = metrics.map(payload => ({ observedAt, payload }));
    this.queued = [...this.queued, ...queued].slice(-MAX_BATCH_REPORTS);
  }

  /** Drop everything queued. */
  clear(): void {
    this.queued = [];
  }

  /** Submit everything queued, keeping it for the next submission if that fails. Resolves to how many were accepted. */
  async submit(): Promise<number> {
    const sent = new Set(this.queued);
    const studio = await this.connect();
    const reports = Array.from(sent, ({ observedAt, payload }): Report => ({
      kind: 'metric',
      subjectId: studio.subjectId,
      observedAt,
      payload
    }));
    const result = await studio.client.reports.submit.v1({ reports });
    if (result instanceof Error) throw result;
    // Keep only what was queued meanwhile; a `clear` meanwhile has dropped everything already.
    this.queued = this.queued.filter(metric => !sent.has(metric));
    return result.accepted;
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
    this.studio = { client, subjectId: `device:${device.id}` };
    return this.studio;
  }
}
