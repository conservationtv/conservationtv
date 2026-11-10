import {
  forwardMetrics,
  type MetricDefinition,
  previewMetrics,
  programMetrics,
  recorderMetrics
} from '@conservationtv/reports';
import { BehaviorSubject } from 'rxjs';
import type { AgentConfiguration } from '../../config.ts';
import {
  addRate,
  type ForwardReading,
  forwardRates,
  publisherRates,
  type Read,
  readMetricsPage
} from '../mediamtx/metrics.ts';
import { type Metric, MetricReporter, summary } from '../reports.ts';
import { PROGRAM_PATH } from './program.ts';
import type { ObsReading } from './streaming.ts';

// The program's reports, from the output agent: every few seconds, a read of the program MediaMTX's metrics page
// (as the gateway MediaMTX's is read, runtimes/mediamtx/metrics.ts) and the watchdog's latest read of obs-websocket
// (streaming.ts); every interval, each subject's samples summarised (least, greatest, mean and last) and submitted:
//
//   program:<showId>       `show/program`: whether it is ready, what it receives, and whether it plays the offline
//                          segment because OBS isn't publishing to it; and OBS's frame rate, skipped frames, and its
//                          stream's congestion and reconnecting (`GetStats`, `GetStreamStatus`).
//   forward:<forwardId>    what each forward destination of `show/program` is sent, and whether it is forwarding. The
//                          destinations are told apart by their place in the path's `forward` list (`pos`), which the
//                          program MediaMTX says the subject of (`destinations`, program.ts).
//   preview:<previewId>    a preview pushed by RTMP is a forward destination too, reported as one. A preview published
//                          by MoQ is its CLI's RTMP read of the preview's own path: what it reads, and whether it does.
//   recorder:<recorderId>  whether OBS records, and how big the recording is so far (`GetRecordStatus`).
//
// A read that fails samples nothing: a gap, not zeroes. Rates need two reads, so the first after a start has none.

/** How often the program MediaMTX and OBS are read. The watchdog reads OBS every 5 seconds. */
const SAMPLE_INTERVAL_MS = 10_000;

/** How often each subject's summary is submitted, as the gateway's path metrics are (studio-configuration.ts). */
const REPORT_INTERVAL_MS = 60_000;

/** What the program's reports are about: the program's subject, and the recorder's while there is one. */
export interface ProgramSubjects {
  program: string;
  recorder: string | undefined;
}

/** A forward destination of `show/program`: a channel's forward, or a preview pushed by RTMP, and its subject. */
export interface ProgramDestination {
  kind: 'forward' | 'preview';
  subject: string;
}

/** What the program metrics read: the program MediaMTX's metrics page, and what it publishes the program to. */
export interface ProgramSource {
  readonly metricsUrl: string;
  /** Each of `show/program`'s forward destinations, by its place in the list (`pos` - 1). */
  destinations(): (ProgramDestination | undefined)[];
  /** Each preview published by MoQ's subject, by the path its CLI reads. */
  moqPreviews(): Map<string, string>;
}

export interface ProgramMetricsStatus {
  /** Whether the program is being read. */
  running: boolean;
  /** ISO 8601. */
  lastScrapedAt: string | null;
  /** Metrics read but not yet accepted. */
  pending: number;
  /** Metrics accepted since the agent started. */
  submitted: number;
  /** ISO 8601. */
  lastSubmittedAt: string | null;
  /** Why the last read or submission failed; cleared by the next success. */
  lastError: string | null;
}

const STOPPED: ProgramMetricsStatus = {
  running: false,
  lastScrapedAt: null,
  pending: 0,
  submitted: 0,
  lastSubmittedAt: null,
  lastError: null
};

/** The previous read of the program MediaMTX, and the seconds since it. */
interface Since {
  previous: Read;
  seconds: number;
}

/** A forward destination in a read, and its ID there. */
interface FoundForward {
  id: string;
  reading: ForwardReading;
}

/** The forward destination of `show/program` at `pos` (from 1) in a read, if it has one. */
function forwardAt(read: Read, pos: number): FoundForward | undefined {
  // MediaMTX gives a destination a new ID whenever it starts afresh: its place in the list is what stays.
  for (const [id, reading] of read.forwards)
    if (reading.path === PROGRAM_PATH && reading.pos === pos) return { id, reading };
  return undefined;
}

/** Each metric's samples this interval, by its definition. */
type Samples = Map<MetricDefinition, number[]>;

/** Reads the program and OBS every few seconds, and submits each subject's summary to the studio API per interval. */
export class ProgramMetrics {
  readonly status$ = new BehaviorSubject<ProgramMetricsStatus>(STOPPED);
  private readonly reporter: MetricReporter;
  private subjects: ProgramSubjects | undefined = undefined;
  private timer: ReturnType<typeof setInterval> | undefined = undefined;
  private intervalStartedAt = 0;
  /** The last reads, for the rates the next ones move at. */
  private previous: Read | undefined = undefined;
  private previousObs: ObsReading | undefined = undefined;
  /** Each subject's samples since the last report. */
  private interval = new Map<string, Samples>();
  private ticking = false;
  private reporting = false;

  /** @param obs The watchdog's latest read of OBS, or null while it doesn't answer. */
  constructor(
    config: AgentConfiguration,
    private readonly source: ProgramSource,
    private readonly obs: () => ObsReading | null
  ) {
    this.reporter = new MetricReporter(config);
  }

  /** Report about `subjects` from now on, starting the timer if it isn't running. */
  apply(subjects: ProgramSubjects): void {
    this.subjects = subjects;
    if (this.timer !== undefined) return;
    this.intervalStartedAt = Date.now();
    this.timer = setInterval(() => void this.tick(), SAMPLE_INTERVAL_MS);
    this.update({ running: true });
  }

  /** Stop reading, and drop what was not submitted. */
  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.subjects = undefined;
    this.previous = undefined;
    this.previousObs = undefined;
    this.interval = new Map();
    this.reporter.clear();
    this.update({ running: false, pending: 0 });
  }

  /** Read, then report if the interval has ended (within half a sample, so jitter never stretches it). */
  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.sample();
      const elapsed = Date.now() - this.intervalStartedAt;
      if (elapsed + SAMPLE_INTERVAL_MS / 2 >= REPORT_INTERVAL_MS) void this.report();
    } finally {
      this.ticking = false;
    }
  }

  /** Sample the program MediaMTX's metrics page and OBS's latest reading into each subject's interval. */
  private async sample(): Promise<void> {
    const subjects = this.subjects;
    if (subjects === undefined) return;
    this.sampleObs(subjects);
    try {
      const { read } = await readMetricsPage(this.source.metricsUrl);
      const previous = this.previous;
      // Rates move between this read and the previous one, so there are none on the first.
      const seconds = previous === undefined ? 0 : (read.at - previous.at) / 1000;
      const since = previous === undefined || seconds <= 0 ? undefined : { previous, seconds };
      this.sampleProgram(subjects.program, read, since);
      this.sampleDestinations(read, since);
      this.sampleMoqPreviews(read, since);
      this.previous = read;
      const at = new Date(read.at);
      this.update({ lastScrapedAt: at.toISOString() });
    } catch (error) {
      this.update({ lastError: error instanceof Error ? error.message : String(error) });
    }
  }

  /** `show/program`: ready, what it receives, and whether OBS publishes to it or the offline segment plays. */
  private sampleProgram(subject: string, read: Read, since: Since | undefined): void {
    const reading = read.paths.get(PROGRAM_PATH);
    const ready = reading?.ready ?? 0;
    this.add(subject, programMetrics.ready, ready > 0 ? 1 : 0);
    this.add(subject, programMetrics.fallback, read.rtmpPublished.has(PROGRAM_PATH) ? 0 : 1);
    const before = since?.previous.paths.get(PROGRAM_PATH);
    if (reading === undefined || before === undefined || since === undefined) return;
    const samples = this.values(subject, programMetrics.ingestBitrate);
    addRate(samples, reading.inboundBytes, before.inboundBytes, since.seconds, 8);
  }

  /**
   * Each forward destination of `show/program`, about the subject its place in the list says: connected while it is
   * forwarding, and what it was sent since the previous read, nothing while it has no destination in the read.
   */
  private sampleDestinations(read: Read, since: Since | undefined): void {
    const rates = since === undefined ? undefined : forwardRates(read, since.previous, since.seconds);
    const destinations = this.source.destinations();
    for (const [index, destination] of destinations.entries()) {
      if (destination !== undefined) this.sampleDestination(destination, forwardAt(read, index + 1), rates);
    }
  }

  /** One forward destination, as `found` in the read, if it is, with what each destination was sent since the last. */
  private sampleDestination(
    destination: ProgramDestination,
    found: FoundForward | undefined,
    rates: Map<string, number> | undefined
  ): void {
    const { kind, subject } = destination;
    const metrics = kind === 'preview' ? previewMetrics : forwardMetrics;
    this.add(subject, metrics.connected, found?.reading.state === 'forwarding' ? 1 : 0);
    if (rates === undefined) return;
    // One missing from the read was sent nothing; one whose count went back gives no rate.
    const rate = found === undefined ? 0 : rates.get(found.id);
    if (rate !== undefined) this.add(subject, metrics.egressBitrate, rate);
  }

  /** Each preview published by MoQ: its CLI's read of the preview's path, from loopback. */
  private sampleMoqPreviews(read: Read, since: Since | undefined): void {
    const rates = since === undefined ? undefined : publisherRates(read, since.previous, since.seconds);
    const reading = new Set<string>();
    for (const publisher of read.publishers.values()) reading.add(publisher.path);
    const previews = this.source.moqPreviews();
    for (const [path, subject] of previews) {
      this.add(subject, previewMetrics.connected, reading.has(path) ? 1 : 0);
      if (rates !== undefined) this.add(subject, previewMetrics.egressBitrate, rates.get(path) ?? 0);
    }
  }

  /** OBS's latest reading, once: its frame rate, skipped frames, its stream's state, and its recording's. */
  private sampleObs(subjects: ProgramSubjects): void {
    const reading = this.obs();
    if (reading === null || reading.at === this.previousObs?.at) return;
    const previous = this.previousObs;
    this.previousObs = reading;
    const { stats, stream, record } = reading;
    const subject = subjects.program;
    this.add(subject, programMetrics.fps, stats.activeFps);
    this.add(subject, programMetrics.congestion, stream.outputCongestion);
    this.add(subject, programMetrics.reconnecting, stream.outputReconnecting ? 1 : 0);
    if (previous !== undefined) this.sampleSkipped(subject, reading, previous);
    if (subjects.recorder === undefined || record === undefined) return;
    this.add(subjects.recorder, recorderMetrics.active, record.outputActive ? 1 : 0);
    this.add(subjects.recorder, recorderMetrics.bytes, record.outputBytes);
  }

  /** How many frames a second OBS skipped rendering and encoding between two readings. */
  private sampleSkipped(subject: string, reading: ObsReading, previous: ObsReading): void {
    const seconds = (reading.at - previous.at) / 1000;
    if (seconds <= 0) return;
    const { stats } = reading;
    const render = this.values(subject, programMetrics.renderSkipped);
    addRate(render, stats.renderSkippedFrames, previous.stats.renderSkippedFrames, seconds, 1);
    const output = this.values(subject, programMetrics.outputSkipped);
    addRate(output, stats.outputSkippedFrames, previous.stats.outputSkippedFrames, seconds, 1);
  }

  /** Add one sample of `metric` about `subject` to this interval. */
  private add(subject: string, metric: MetricDefinition, value: number): void {
    const values = this.values(subject, metric);
    values.push(value);
  }

  /** This interval's samples of `metric` about `subject`, so far. */
  private values(subject: string, metric: MetricDefinition): number[] {
    const samples = this.interval.get(subject) ?? new Map<MetricDefinition, number[]>();
    this.interval.set(subject, samples);
    const values = samples.get(metric) ?? [];
    samples.set(metric, values);
    return values;
  }

  /** Submit each subject's summary of the interval, and start the next. */
  private async report(): Promise<void> {
    const subjects = this.interval;
    this.interval = new Map();
    const now = new Date();
    this.intervalStartedAt = now.getTime();
    const observedAt = now.toISOString();
    for (const [subject, samples] of subjects) {
      const metrics: Metric[] = [...samples].map(([metric, values]) => summary(metric, values));
      this.reporter.queue(observedAt, metrics, subject);
    }
    this.update({ pending: this.reporter.queued });
    if (this.reporting || this.reporter.queued === 0) return;
    this.reporting = true;
    try {
      const { accepted, submittedAt } = await this.reporter.submit();
      const current = this.status$.getValue();
      const submitted = current.submitted + accepted;
      this.update({ submitted, lastSubmittedAt: submittedAt, pending: this.reporter.queued, lastError: null });
    } catch (error) {
      this.update({ lastError: error instanceof Error ? error.message : String(error) });
    } finally {
      this.reporting = false;
    }
  }

  private update(changes: Partial<ProgramMetricsStatus>): void {
    this.status$.next({ ...this.status$.value, ...changes });
  }
}
