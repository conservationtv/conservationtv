import { type PrometheusSample, parseMetrics } from '@conservationtv/mediamtx';
import { BehaviorSubject } from 'rxjs';
import { type Metric, type MetricReporter, summary } from '../reports.ts';

// MediaMTX's metrics, shipped to the studio API per path. On one timer, every few seconds, read its metrics page for
// each path's state, readers, and how fast its byte and frame-error counters moved since the last read; the read that
// ends an interval then submits each path's samples summarised (least, greatest, mean and last) as metrics about the
// agent's device, with the path as the `path` dimension, so each path is a series of its own. A path missing from a
// read counts as not ready with nothing flowing, so one that stops mid-interval shows in that interval's summary; one
// missing for a whole interval is not reported. Per-session and per-protocol samples are not shipped.

/** How often MediaMTX's metrics page is read, at most: the samples each interval's summaries are made from. */
const SAMPLE_INTERVAL_MS = 10_000;

/** What one read of the metrics page says of a path. Byte and error counts are MediaMTX's running totals. */
interface PathReading {
  ready: number;
  readers: number;
  inboundBytes: number;
  outboundBytes: number;
  framesInError: number;
}

/** A path's samples so far this interval. Bitrates are bits a second, errors frames a second. */
interface PathSamples {
  ready: number[];
  readers: number[];
  ingestBitrate: number[];
  egressBitrate: number[];
  frameErrors: number[];
}

/** A read of the metrics page: each path's reading, at a time. */
interface Read {
  at: number;
  paths: Map<string, PathReading>;
}

/** The per-path samples a reading is made from, by the field each adds to. */
const PATH_FIELDS = new Map<string, keyof PathReading>([
  ['paths', 'ready'],
  ['paths_readers', 'readers'],
  ['paths_inbound_bytes', 'inboundBytes'],
  ['paths_outbound_bytes', 'outboundBytes'],
  ['paths_inbound_frames_in_error', 'framesInError']
]);

/** Each path's reading, adding up the samples MediaMTX gives it per label, such as one per reader type. */
function readingsOf(samples: PrometheusSample[]): Map<string, PathReading> {
  const paths = new Map<string, PathReading>();
  for (const sample of samples) {
    // A per-path sample adds to its path's reading, under the field its name gives. MediaMTX gives `paths` under the
    // path's state, so only a ready path's counts as ready, but every path gets a reading.
    const path = sample.labels.name;
    const field = PATH_FIELDS.get(sample.name);
    if (sample.deprecated || path === undefined || field === undefined) continue;
    const reading = paths.get(path) ?? { ready: 0, readers: 0, inboundBytes: 0, outboundBytes: 0, framesInError: 0 };
    paths.set(path, reading);
    if (field !== 'ready' || sample.labels.state === 'ready') reading[field] += sample.value;
  }
  return paths;
}

/** Sample how fast a running total moved between two reads, a second, times `scale`. */
function addRate(into: number[], current: number, previous: number, seconds: number, scale: number): void {
  // A total that went back was reset, as on a restart, so this read gives no rate.
  const moved = current - previous;
  if (moved >= 0) into.push((moved * scale) / seconds);
}

/** Sample a path missing from a read: it has stopped, so nothing is ready, read or flowing. */
function addStopped(samples: PathSamples): void {
  samples.ready.push(0);
  samples.readers.push(0);
  samples.ingestBitrate.push(0);
  samples.egressBitrate.push(0);
  samples.frameErrors.push(0);
}

/**
 * Each path's summaries of an interval, with the path as their `path` dimension. Every path read this interval has
 * its state and readers; its rates need two reads, so its first interval may have none.
 */
function metricsOf(paths: Map<string, PathSamples>): Metric[] {
  const metrics: Metric[] = [];
  for (const [path, samples] of paths) {
    const dimensions = { path };
    metrics.push(summary('path.ready', samples.ready, 'boolean', dimensions));
    metrics.push(summary('path.readers', samples.readers, 'readers', dimensions));
    if (samples.ingestBitrate.length > 0)
      metrics.push(summary('path.ingest.bitrate', samples.ingestBitrate, 'bits/s', dimensions));
    if (samples.egressBitrate.length > 0)
      metrics.push(summary('path.egress.bitrate', samples.egressBitrate, 'bits/s', dimensions));
    if (samples.frameErrors.length > 0)
      metrics.push(summary('path.ingest.frame_errors', samples.frameErrors, 'frames/s', dimensions));
  }
  return metrics;
}

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

/** Reads MediaMTX's metrics page every few seconds, and submits each path's summary through `reporter` per interval. */
export class MediamtxMetrics {
  readonly status$ = new BehaviorSubject<MediamtxMetricsStatus>(METRICS_STOPPED);
  private readonly url: string;
  private timer: ReturnType<typeof setInterval> | undefined = undefined;
  private sampleMs = SAMPLE_INTERVAL_MS;
  private intervalMs = 0;
  /** When the interval being sampled began, in milliseconds since the epoch. */
  private intervalStartedAt = 0;
  /** The last read, for the rates the next one moves at. */
  private previous: Read | undefined = undefined;
  /** Each path's samples since the last report. */
  private interval = new Map<string, PathSamples>();
  /** Whether a tick's read, or a submission, is under way: a slow one skips the ticks it overlaps. */
  private ticking = false;
  private reporting = false;

  /** @param address Where the metrics page listens, such as `127.0.0.1:9998`. */
  constructor(
    address: string,
    private readonly reporter: MetricReporter
  ) {
    this.url = `http://${address}/metrics`;
  }

  /** Read every few seconds, and report every `intervalMs`, from now on. */
  start(intervalMs: number): void {
    this.clear();
    this.update({ running: true, intervalMs });
    this.intervalMs = intervalMs;
    this.sampleMs = Math.min(SAMPLE_INTERVAL_MS, intervalMs);
    this.intervalStartedAt = Date.now();
    this.timer = setInterval(() => void this.tick(), this.sampleMs);
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

  /**
   * Read the metrics page, then report if the interval has ended. A tick within half a sample of the end reports, so
   * timer jitter never stretches an interval by a whole sample. The report is not waited for: a slow submission must
   * not hold up the reads, and the next report sends what it could not.
   */
  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.sample();
      const elapsed = Date.now() - this.intervalStartedAt;
      if (elapsed + this.sampleMs / 2 >= this.intervalMs) void this.report();
    } finally {
      this.ticking = false;
    }
  }

  /** Read the metrics page into each path's samples. A failed read is reported in the status, and skipped. */
  private async sample(): Promise<void> {
    try {
      const response = await fetch(this.url, { signal: AbortSignal.timeout(SCRAPE_TIMEOUT_MS) });
      if (!response.ok) throw new Error(`MediaMTX's metrics page answered ${response.status}`);
      const text = await response.text();
      const samples = parseMetrics(text);
      const now = new Date();
      this.record({ at: now.getTime(), paths: readingsOf(samples) });
      this.update({ lastScrapedAt: now.toISOString(), samples: samples.length });
    } catch (error) {
      this.update({ lastError: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Add a read's samples to each path's interval, and keep it for the next read's rates. */
  private record(read: Read): void {
    const previous = this.previous;
    for (const [path, reading] of read.paths) {
      // A path in the read samples its state and readers, and its rates when the previous read had it too.
      const samples = this.interval.get(path) ?? {
        ready: [],
        readers: [],
        ingestBitrate: [],
        egressBitrate: [],
        frameErrors: []
      };
      this.interval.set(path, samples);
      samples.ready.push(reading.ready > 0 ? 1 : 0);
      samples.readers.push(reading.readers);
      const before = previous?.paths.get(path);
      if (previous === undefined || before === undefined) continue;
      const seconds = (read.at - previous.at) / 1000;
      addRate(samples.ingestBitrate, reading.inboundBytes, before.inboundBytes, seconds, 8);
      addRate(samples.egressBitrate, reading.outboundBytes, before.outboundBytes, seconds, 8);
      addRate(samples.frameErrors, reading.framesInError, before.framesInError, seconds, 1);
    }
    // A path seen this interval but missing from the read has stopped.
    for (const [path, samples] of this.interval) if (!read.paths.has(path)) addStopped(samples);
    this.previous = read;
  }

  /** Submit each path's summary of the interval, and start the next. */
  private async report(): Promise<void> {
    // The interval's summaries are queued even while a submission is under way, which sends them with the next.
    const paths = this.interval;
    this.interval = new Map();
    const now = new Date();
    this.intervalStartedAt = now.getTime();
    this.reporter.queue(now.toISOString(), metricsOf(paths));
    if (this.reporting || this.reporter.queued === 0) return;
    this.reporting = true;
    try {
      const { accepted, submittedAt } = await this.reporter.submit();
      const current = this.status$.getValue();
      this.update({ submitted: current.submitted + accepted, lastSubmittedAt: submittedAt, lastError: null });
    } catch (error) {
      this.update({ lastError: error instanceof Error ? error.message : String(error) });
    } finally {
      this.reporting = false;
    }
  }

  private update(change: Partial<MediamtxMetricsStatus>): void {
    if (this.status$.closed) return;
    const current = this.status$.getValue();
    const { reporter } = this;
    this.status$.next({ ...current, ...change, subjectId: reporter.subjectId, pending: reporter.queued });
  }

  private clear(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.previous = undefined;
    this.interval = new Map();
  }
}
