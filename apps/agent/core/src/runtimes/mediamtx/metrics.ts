import { type PrometheusSample, parseMetrics } from '@conservationtv/mediamtx';
import { BehaviorSubject } from 'rxjs';
import { type Metric, type MetricReporter, gauge } from '../reports.ts';

// MediaMTX's metrics, shipped to the studio API: on an interval, read its metrics page and submit every sample as a
// gauge about the agent's device, named `mediamtx.<sample>` with the sample's labels as dimensions. The samples
// MediaMTX keeps only for compatibility are left out.

export interface MediamtxMetricsStatus {
  /** Whether the metrics page is being read. */
  running: boolean;
  intervalMs: number | null;
  /** The subject the reports are about, once the studio API has said which device the agent is. */
  subjectId: string | null;
  /** ISO 8601. */
  lastScrapedAt: string | null;
  /** How many samples the last read found. */
  samples: number;
  /** Metrics read but not yet accepted. */
  pending: number;
  /** Metrics accepted since the agent started; carried across spec changes. */
  submitted: number;
  /** ISO 8601. */
  lastSubmittedAt: string | null;
  /** Why the last read or submission failed; cleared by the next success. */
  lastError: string | null;
}

export const METRICS_STOPPED: MediamtxMetricsStatus = {
  running: false,
  intervalMs: null,
  subjectId: null,
  lastScrapedAt: null,
  samples: 0,
  pending: 0,
  submitted: 0,
  lastSubmittedAt: null,
  lastError: null
};

const SCRAPE_TIMEOUT_MS = 5_000;

/** What a sample counts, from its name: MediaMTX names bytes and packets as such, and counts everything else. */
function unitOf(name: string): string {
  if (name.includes('bytes')) return 'bytes';
  if (name.includes('packets')) return 'packets';
  return 'count';
}

function metricsOf(samples: PrometheusSample[]): Metric[] {
  return samples
    .filter(sample => !sample.deprecated)
    .map(sample => gauge(`mediamtx.${sample.name}`, sample.value, unitOf(sample.name), sample.labels));
}

/** Reads MediaMTX's metrics page on an interval, and submits what it finds through `reporter`. */
export class MediamtxMetrics {
  readonly status$ = new BehaviorSubject<MediamtxMetricsStatus>(METRICS_STOPPED);
  private readonly url: string;
  private timer: ReturnType<typeof setInterval> | undefined = undefined;
  /** Whether a tick is under way: a slow submission skips the ticks it overlaps rather than piling up. */
  private ticking = false;

  /** @param address Where the metrics page listens, such as `127.0.0.1:9998`. */
  constructor(
    address: string,
    private readonly reporter: MetricReporter
  ) {
    this.url = `http://${address}/metrics`;
  }

  /** Read at `intervalMs` from now on. */
  start(intervalMs: number): void {
    this.clear();
    this.update({ running: true, intervalMs });
    this.timer = setInterval(() => void this.tick(), intervalMs);
  }

  /** Stop reading, and drop what was not submitted. Safe when it never started. */
  stop(): void {
    this.clear();
    this.reporter.clear();
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
      const samples = await this.scrape();
      await this.submit();
      this.update({ samples: samples.length });
    } catch (error) {
      this.update({ lastError: error instanceof Error ? error.message : String(error) });
    } finally {
      this.ticking = false;
    }
  }

  private async scrape(): Promise<PrometheusSample[]> {
    const response = await fetch(this.url, { signal: AbortSignal.timeout(SCRAPE_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`MediaMTX's metrics page answered ${response.status}`);
    const samples = parseMetrics(await response.text());
    const now = new Date();
    this.reporter.queue(now.toISOString(), metricsOf(samples));
    this.update({ lastScrapedAt: now.toISOString() });
    return samples;
  }

  private async submit(): Promise<void> {
    const { accepted, submittedAt } = await this.reporter.submit();
    const current = this.status$.getValue();
    this.update({ submitted: current.submitted + accepted, lastSubmittedAt: submittedAt, lastError: null });
  }

  private update(change: Partial<MediamtxMetricsStatus>): void {
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
