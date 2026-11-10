import type { MetricDefinition } from '@conservationtv/reports';
import { BehaviorSubject } from 'rxjs';
import { type Metric, type MetricQueue, summary, useMetricReporter } from './reports.ts';

// The timing the agent's summarising monitors share: what the program, the gateway's paths, the relays' traffic and
// the channels' platforms report is each sampled on a timer, and summarised per interval. A monitor gives only how to
// take a sample; the sampler owns the rest:
//
//   1. every `sampleMs`, it takes a sample into the interval's series: each metric's samples, by the series' key,
//      usually its subject. A tick whose sample is still under way when the next is due skips that one;
//   2. the sample that ends an interval, within half a sample of `reportMs` so timer jitter never stretches it by a
//      whole sample, starts the next interval and queues each series' summary (least, greatest, mean and last) of
//      every metric it has samples of, about the subject its key says;
//   3. then submits the monitor's queue (reports.ts), unless a submission is under way: a slow one must not hold up
//      the samples, and the next report sends what it could not.
//
// A sample that fails says so in the status, and adds nothing: a gap, not zeroes.

/** What every sampler's status says, beside whatever its monitor adds. */
export interface SamplerStatus {
  /** Whether it is sampling. */
  running: boolean;
  /** Metrics summarised but not yet accepted. */
  pending: number;
  /** Metrics accepted since the agent started; carried across spec changes. */
  submitted: number;
  /** ISO 8601. */
  lastSubmittedAt: string | null;
  /** Why the last sample or submission failed; cleared by the next submission. */
  lastError: string | null;
}

const STOPPED: SamplerStatus = { running: false, pending: 0, submitted: 0, lastSubmittedAt: null, lastError: null };

/** What a series' summaries are about: a subject, or the agent's device without one, and their dimensions. */
export interface SeriesTarget {
  subjectId: string | undefined;
  dimensions: Record<string, string>;
}

/** How often a sampler samples, and how often it reports what it sampled. */
export interface SamplerTiming {
  sampleMs: number;
  reportMs: number;
}

/** One interval's samples so far: each metric's, by the series they are of. */
export class IntervalSamples {
  private readonly series = new Map<string, Map<MetricDefinition, number[]>>();

  /** Add one sample of `metric` to the series `key`. */
  add(key: string, metric: MetricDefinition, value: number): void {
    const values = this.values(key, metric);
    values.push(value);
  }

  /** The series `key`'s samples of `metric` so far, to add to. */
  values(key: string, metric: MetricDefinition): number[] {
    const metrics = this.series.get(key) ?? new Map<MetricDefinition, number[]>();
    this.series.set(key, metrics);
    const values = metrics.get(metric) ?? [];
    metrics.set(metric, values);
    return values;
  }

  /** The series sampled so far this interval. */
  keys(): IterableIterator<string> {
    return this.series.keys();
  }

  /** Each series' summary of every metric it has samples of, with `dimensions`. */
  summaries(key: string, dimensions: Record<string, string>): Metric[] {
    const metrics = this.series.get(key) ?? new Map<MetricDefinition, number[]>();
    const sampled = [...metrics].filter(([, values]) => values.length > 0);
    return sampled.map(([metric, values]) => summary(metric, values, dimensions));
  }
}

/** What a monitor gives its sampler. */
export interface SamplerOptions<Extra> {
  /** What the monitor adds to the status, before it first runs. */
  stopped: Extra;
  /** Take one sample into `samples`. A throw is the status's `lastError`, and samples nothing more. */
  sample(samples: IntervalSamples): Promise<void> | void;
  /** What the series `key`'s summaries are about, or undefined to leave it out. Without it, the key is the subject. */
  target?(key: string): SeriesTarget | undefined;
}

/**
 * Samples a monitor on a timer, and submits each series' summary to the studio API per interval. Its status is the
 * sampler's own, with `Extra`, what the monitor adds.
 */
export class Sampler<Extra> {
  readonly status$: BehaviorSubject<SamplerStatus & Extra>;
  private readonly queue: MetricQueue;
  /** The status's two parts: the sampler's own, and what the monitor adds. */
  private own: SamplerStatus = STOPPED;
  private extra: Extra;
  private timer: ReturnType<typeof setInterval> | undefined = undefined;
  /** When the interval being sampled began, in milliseconds since the epoch. */
  private intervalStartedAt = 0;
  private interval = new IntervalSamples();
  /** Whether a tick's sample, or a submission, is under way: a slow one skips the ticks it overlaps. */
  private ticking = false;
  private reporting = false;

  constructor(private readonly options: SamplerOptions<Extra>) {
    this.extra = options.stopped;
    this.status$ = new BehaviorSubject({ ...options.stopped, ...STOPPED });
    const reporter = useMetricReporter();
    this.queue = reporter.queue();
  }

  /** Whether it is sampling. */
  get running(): boolean {
    return this.timer !== undefined;
  }

  /** Sample afresh from now on, at `timing`: what this interval sampled so far is dropped, what was queued is kept. */
  start(timing: SamplerTiming): void {
    this.clear();
    this.intervalStartedAt = Date.now();
    this.timer = setInterval(() => void this.tick(timing), timing.sampleMs);
    this.set({ running: true });
  }

  /** Stop sampling, and drop what was not submitted. Safe when it never started. */
  stop(): void {
    this.clear();
    this.queue.clear();
    this.set({ running: false });
  }

  /** Stop the timer for good when the agent stops; not a removal, so the status is left as it was. */
  dispose(): void {
    this.clear();
    this.status$.complete();
  }

  /** Change what the monitor adds to the status. */
  update(changes: Partial<Extra>): void {
    this.extra = { ...this.extra, ...changes };
    this.set({});
  }

  /** Say why a sample failed, in the status, until the next submission. */
  failed(message: string): void {
    this.set({ lastError: message });
  }

  /** Sample, then report if the interval has ended. The report is not waited for. */
  private async tick(timing: SamplerTiming): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.sample();
      const elapsed = Date.now() - this.intervalStartedAt;
      if (elapsed + timing.sampleMs / 2 >= timing.reportMs) void this.report();
    } finally {
      this.ticking = false;
    }
  }

  private async sample(): Promise<void> {
    try {
      await this.options.sample(this.interval);
    } catch (error) {
      this.failed(error instanceof Error ? error.message : String(error));
    }
  }

  /** Queue each series' summary of the interval, start the next, and submit. */
  private async report(): Promise<void> {
    // The interval's summaries are queued even while a submission is under way, which sends them with the next.
    const interval = this.interval;
    this.interval = new IntervalSamples();
    const now = new Date();
    this.intervalStartedAt = now.getTime();
    const observedAt = now.toISOString();
    for (const key of interval.keys()) {
      const target = this.targetOf(key);
      if (target === undefined) continue;
      const metrics = interval.summaries(key, target.dimensions);
      if (metrics.length > 0) this.queue.queue(observedAt, metrics, target.subjectId);
    }
    this.set({});
    if (this.reporting || this.queue.queued === 0) return;
    this.reporting = true;
    try {
      const { accepted, submittedAt } = await this.queue.submit();
      const submitted = this.own.submitted + accepted;
      this.set({ submitted, lastSubmittedAt: submittedAt, lastError: null });
    } catch (error) {
      this.failed(error instanceof Error ? error.message : String(error));
    } finally {
      this.reporting = false;
    }
  }

  /** What the series `key` is about: the monitor's say, or the key as the subject. */
  private targetOf(key: string): SeriesTarget | undefined {
    const { target } = this.options;
    if (target === undefined) return { subjectId: key, dimensions: {} };
    return target(key);
  }

  /** Change the sampler's own part of the status, with what is pending as it is now, and say so. */
  private set(changes: Partial<SamplerStatus>): void {
    this.own = { ...this.own, ...changes, pending: this.queue.queued };
    if (this.status$.closed) return;
    this.status$.next({ ...this.extra, ...this.own });
  }

  private clear(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.interval = new IntervalSamples();
  }
}
