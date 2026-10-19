import { Client, DeviceIdentity, deviceSignature, type PostReportsData } from '@conservationtv/studio-sdk';
import type { ConservationTvConfiguration } from './config.ts';

// Reporting to the studio API: metrics submitted with `reports.submit`, signed as the agent's device and about it,
// `device:<id>`. The agent knows only its key, so it asks the studio API who it is (`whoami.get`) before its first
// submission, and again until it gets an answer. Every runtime that reports shares the one connection.
//
// A submission that fails is kept and retried with the next, oldest dropped first beyond a reporter's capacity. The
// API does not deduplicate, so a submission that failed after being stored may be stored twice: these are cheap
// operational signals, and losing a gap is worse.

export type Report = PostReportsData['body']['reports'][number];
type MetricReport = Extract<Report, Record<'kind', 'metric'>>;
export type Metric = MetricReport['payload'];

/** A metric sampled but not yet accepted. Its subject is added on submission, once the device is known. */
export interface PendingMetric {
  observedAt: string;
  payload: Metric;
}

/** The most reports one submission carries, as the studio API accepts. */
export const MAX_BATCH_REPORTS = 1000;

/** The studio API, signed as the agent's device, and the subject that device reports about itself as. */
export interface Studio {
  client: Client;
  subjectId: string;
}

/** The studio API and the agent's device, asked for on first use and kept; asked again if that fails. */
export class StudioConnection {
  private studio: Promise<Studio> | undefined = undefined;

  constructor(private readonly config: ConservationTvConfiguration) {}

  connect(): Promise<Studio> {
    if (this.studio !== undefined) return this.studio;
    const studio = this.open();
    this.studio = studio;
    // Forgotten if it fails, so the next use asks again.
    studio.catch(() => {
      if (this.studio === studio) this.studio = undefined;
    });
    return studio;
  }

  private async open(): Promise<Studio> {
    const identity = await DeviceIdentity.fromSecretKey(this.config.secretKey);
    const client = new Client({ baseUrl: this.config.studioUrl, auth: deviceSignature(identity) });
    await client.handshake();
    const device = await client.whoami.get.v1();
    if (device instanceof Error) throw device;
    return { client, subjectId: `device:${device.id}` };
  }
}

/** How a reporter's submissions are going. */
export interface ReportingStatus {
  /** The subject the reports are about, once the studio API has said which device the agent is. */
  subjectId: string | null;
  /** Reports sampled but not yet accepted. */
  pending: number;
  /** Reports accepted since the agent started; carried across spec changes. */
  submitted: number;
  /** ISO 8601. */
  lastSubmittedAt: string | null;
  /** Why the last attempt to identify or submit failed; cleared by the next success. */
  lastError: string | null;
}

export const NOT_REPORTED: ReportingStatus = {
  subjectId: null,
  pending: 0,
  submitted: 0,
  lastSubmittedAt: null,
  lastError: null
};

export interface MetricReporterOptions {
  /** The most metrics kept while submissions fail; the oldest are dropped beyond it. */
  capacity: number;
  /** Called with the reporter's status whenever it changes. */
  onChange(status: ReportingStatus): void;
}

/** Metrics queued by one runtime, and submitted about the agent's device in batches the studio API accepts. */
export class MetricReporter {
  private pending: PendingMetric[] = [];
  private status: ReportingStatus = NOT_REPORTED;

  constructor(
    private readonly studio: StudioConnection,
    private readonly options: MetricReporterOptions
  ) {}

  /** Queue metrics, dropping the oldest beyond the reporter's capacity. */
  queue(metrics: PendingMetric[]): void {
    this.pending = [...this.pending, ...metrics].slice(-this.options.capacity);
    this.change({});
  }

  /** Drop everything not yet submitted. */
  clear(): void {
    this.pending = [];
    this.change({});
  }

  /** Submit what is pending, a batch at a time, keeping what was not accepted for the next call. Never throws. */
  async submit(): Promise<void> {
    const due = this.pending;
    try {
      const studio = await this.studio.connect();
      this.change({ subjectId: studio.subjectId });
      for (let start = 0; start < due.length; start += MAX_BATCH_REPORTS) {
        // Only what is still pending: a clear meanwhile has dropped everything already.
        const remaining = new Set(this.pending);
        const batch = due.slice(start, start + MAX_BATCH_REPORTS).filter(metric => remaining.has(metric));
        if (batch.length === 0) continue;
        const reports = batch.map(({ observedAt, payload }): Report => ({
          kind: 'metric',
          subjectId: studio.subjectId,
          observedAt,
          payload
        }));
        const result = await studio.client.reports.submit.v1({ reports });
        if (result instanceof Error) throw result;
        const sent = new Set(batch);
        this.pending = this.pending.filter(metric => !sent.has(metric));
        const now = new Date();
        this.change({
          submitted: this.status.submitted + result.accepted,
          lastSubmittedAt: now.toISOString(),
          lastError: null
        });
      }
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.change({ lastError: failure.message });
    }
  }

  private change(change: Partial<ReportingStatus>): void {
    this.status = { ...this.status, ...change, pending: this.pending.length };
    this.options.onChange(this.status);
  }
}
