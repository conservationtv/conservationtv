import { type PrometheusSample, parseMetrics } from '@conservationtv/mediamtx';
import { pathMetrics } from '@conservationtv/reports';
import { BehaviorSubject } from 'rxjs';
import { z } from 'zod';
import type { AgentConfiguration } from '../../config.ts';
import { type Metric, MetricReporter, summary } from '../reports.ts';
import { type PathIndex, type PathTarget, PathAttributionsSchema, pathIndexOf } from './paths.ts';

// The `metrics` key, fulfilled by MediaMTX's metrics, shipped to the studio API per path. On one timer, every few
// seconds, read its metrics page for each path's state, readers, and how fast its byte and frame-error counters moved
// since the last read; the read that ends an interval then submits each path's samples summarised (least, greatest,
// mean and last), so each path is a series of its own: about the exposure the spec says it delivers, with its rendition
// as a dimension, or, while the spec names no paths, about the agent's device with the path as the `path` dimension. A
// path the spec does not name is not reported. A path missing from a read counts as not ready with nothing flowing, so
// one that stops mid-interval shows in that interval's summary; one missing for a whole interval is not reported.
//
// What a path sends is split by who reads it. The agent's MoQ publishers read each path they publish over RTMP from
// loopback (builders/publishers.ts), all of it for as long as they run, so those readers' bytes are its publisher
// egress, and everything else it sends, to any other reader, its LAN egress. What actually reaches the relay is the
// relay's to count (relay-traffic.ts). Per-session and per-protocol samples are not shipped.
//
// Reading the page (`readMetricsPage`), and the rates between two reads, are shared with the obs runtime, which reads
// its program MediaMTX's page the same way (runtimes/obs/program-metrics.ts).

/** How often to report the streams' metrics, and what each path's are about. */
export const MetricsSpecSchema = z.object({
  /** How often each path's summary is submitted. */
  intervalMs: z.number().int().min(1_000),
  /** The paths whose metrics are about an exposure. None, and every path's are about the agent's device. */
  paths: PathAttributionsSchema.default([])
});
export type MetricsSpec = z.output<typeof MetricsSpecSchema>;

/** How often MediaMTX's metrics page is read, at most: the samples each interval's summaries are made from. */
const SAMPLE_INTERVAL_MS = 10_000;

/** What one read of the metrics page says of a path. Byte and error counts are MediaMTX's running totals. */
export interface PathReading {
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
  lanEgressBitrate: number[];
  publisherEgressBitrate: number[];
  frameErrors: number[];
}

/** One of the agent's MoQ publishers reading a path: the path, and the bytes sent it so far on this connection. */
export interface PublisherReading {
  path: string;
  outboundBytes: number;
}

/**
 * One of a path's forward destinations (its config's `forward`): the path, its place in that list (from 1), MediaMTX's
 * state for it (`idle`, `forwarding` or `error`), and the bytes sent it so far.
 */
export interface ForwardReading {
  path: string;
  pos: number;
  state: string;
  outboundBytes: number;
}

/**
 * A read of the metrics page, at a time: each path's reading, each publisher connection's and each forward
 * destination's, by its ID, and the paths something publishes to over RTMP.
 */
export interface Read {
  at: number;
  paths: Map<string, PathReading>;
  publishers: Map<string, PublisherReading>;
  forwards: Map<string, ForwardReading>;
  rtmpPublished: Set<string>;
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
export function readingsOf(samples: PrometheusSample[]): Map<string, PathReading> {
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

/**
 * Whether a reading RTMP connection is one of the agent's MoQ publishers rather than a reader on the network. The
 * publishers are the only RTMP readers on MediaMTX's own machine (builders/publishers.ts), so for now that is told by
 * the connection coming from loopback. This is the one place that says so: telling them apart some other way only
 * changes this.
 */
function isAgentPublisher(remoteAddr: string | undefined): boolean {
  return remoteAddr !== undefined && (remoteAddr.startsWith('127.') || remoteAddr.startsWith('[::1]'));
}

/** Each of the agent's MoQ publishers' connections (`isAgentPublisher`), by connection ID. */
function publishersOf(samples: PrometheusSample[]): Map<string, PublisherReading> {
  const publishers = new Map<string, PublisherReading>();
  for (const sample of samples) {
    // A reading RTMP connection that is one of the agent's publishers counts as publisher egress; every other
    // connection is a reader on the network, counted with the path's total.
    const { id, path, remoteAddr, state } = sample.labels;
    if (sample.deprecated || sample.name !== 'rtmp_conns_outbound_bytes' || state !== 'read') continue;
    if (id === undefined || path === undefined || !isAgentPublisher(remoteAddr)) continue;
    publishers.set(id, { path, outboundBytes: sample.value });
  }
  return publishers;
}

/** Each forward destination, by its ID, which MediaMTX gives it anew whenever it starts forwarding afresh. */
function forwardsOf(samples: PrometheusSample[]): Map<string, ForwardReading> {
  const forwards = new Map<string, ForwardReading>();
  for (const sample of samples) {
    // Each destination's byte count, labelled with its path, its place in the path's list, and its state; anything
    // else, or one missing a label, is skipped.
    const { id, path, pos, state } = sample.labels;
    if (sample.deprecated || sample.name !== 'forward_dests_outbound_bytes') continue;
    if (id === undefined || path === undefined || pos === undefined) continue;
    forwards.set(id, { path, pos: Number(pos), state: state ?? '', outboundBytes: sample.value });
  }
  return forwards;
}

/** The paths an RTMP connection publishes to: OBS's stream to the program, say. */
function rtmpPublishedOf(samples: PrometheusSample[]): Set<string> {
  const published = new Set<string>();
  for (const sample of samples) {
    // Each RTMP connection publishing to a path; reading ones, and deprecated duplicates, are skipped.
    const { path, state } = sample.labels;
    if (sample.deprecated || sample.name !== 'rtmp_conns' || state !== 'publish' || path === undefined) continue;
    published.add(path);
  }
  return published;
}

/** A read of the metrics page, and how many samples it had. */
export interface MetricsPage {
  read: Read;
  samples: number;
}

/** Reads MediaMTX's metrics page at `url`, as of now. Throws if it doesn't answer, or answers with an error. */
export async function readMetricsPage(url: string): Promise<MetricsPage> {
  const response = await fetch(url, { signal: AbortSignal.timeout(SCRAPE_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`MediaMTX's metrics page answered ${response.status}`);
  const text = await response.text();
  const samples = parseMetrics(text);
  const read: Read = {
    at: Date.now(),
    paths: readingsOf(samples),
    publishers: publishersOf(samples),
    forwards: forwardsOf(samples),
    rtmpPublished: rtmpPublishedOf(samples)
  };
  return { read, samples: samples.length };
}

/**
 * How many bits a second each forward destination was sent between two reads, by its ID. One the previous read did not
 * have counts from zero, as one started since; one whose count went back was reset, and gives no rate.
 */
export function forwardRates(read: Read, previous: Read, seconds: number): Map<string, number> {
  const rates = new Map<string, number>();
  for (const [id, reading] of read.forwards) {
    const before = previous.forwards.get(id)?.outboundBytes ?? 0;
    const moved = reading.outboundBytes - before;
    if (moved >= 0) rates.set(id, (moved * 8) / seconds);
  }
  return rates;
}

/**
 * How many bits a second each path sent its publishers between two reads. A connection counts from zero when the
 * previous read did not have it, as one opened since; one whose count went back was reset, and gives no rate.
 */
export function publisherRates(read: Read, previous: Read, seconds: number): Map<string, number> {
  const rates = new Map<string, number>();
  for (const [id, reading] of read.publishers) {
    // Each connection adds what it moved to its path's rate: from zero if it is new, nothing if its count went back.
    const before = previous.publishers.get(id)?.outboundBytes ?? 0;
    const moved = reading.outboundBytes - before;
    if (moved < 0) continue;
    rates.set(reading.path, (rates.get(reading.path) ?? 0) + (moved * 8) / seconds);
  }
  return rates;
}

/** Sample how fast a running total moved between two reads, a second, times `scale`. */
export function addRate(into: number[], current: number, previous: number, seconds: number, scale: number): void {
  // A total that went back was reset, as on a restart, so this read gives no rate.
  const moved = current - previous;
  if (moved >= 0) into.push((moved * scale) / seconds);
}

/**
 * Sample what a path sent between two reads, split by who read it: `publishers`, the rate its publishers read, and the
 * rest of its total, the LAN. A total that went back gives neither, as a reset.
 */
function addEgress(
  samples: PathSamples,
  reading: PathReading,
  before: PathReading,
  seconds: number,
  publishers: number
): void {
  const moved = reading.outboundBytes - before.outboundBytes;
  if (moved < 0) return;
  const total = (moved * 8) / seconds;
  samples.publisherEgressBitrate.push(Math.min(publishers, total));
  samples.lanEgressBitrate.push(Math.max(total - publishers, 0));
}

/** A path with no samples yet this interval. */
function emptySamples(): PathSamples {
  return {
    ready: [],
    readers: [],
    ingestBitrate: [],
    lanEgressBitrate: [],
    publisherEgressBitrate: [],
    frameErrors: []
  };
}

/** The time between two reads, and how fast each path sent its publishers over it. */
interface MovedSince {
  seconds: number;
  toPublishers: Map<string, number>;
}

/** Undefined for the first read, which has nothing to move from. */
function movedSince(read: Read, previous: Read | undefined): MovedSince | undefined {
  if (previous === undefined) return undefined;
  const seconds = (read.at - previous.at) / 1000;
  return { seconds, toPublishers: publisherRates(read, previous, seconds) };
}

/** Sample how fast a path's counters moved since the previous read had it. */
function addRates(samples: PathSamples, path: string, reading: PathReading, before: PathReading, since: MovedSince) {
  addRate(samples.ingestBitrate, reading.inboundBytes, before.inboundBytes, since.seconds, 8);
  addEgress(samples, reading, before, since.seconds, since.toPublishers.get(path) ?? 0);
  addRate(samples.frameErrors, reading.framesInError, before.framesInError, since.seconds, 1);
}

/** Sample a path missing from a read: it has stopped, so nothing is ready, read or flowing. */
function addStopped(samples: PathSamples): void {
  samples.ready.push(0);
  samples.readers.push(0);
  samples.ingestBitrate.push(0);
  samples.lanEgressBitrate.push(0);
  samples.publisherEgressBitrate.push(0);
  samples.frameErrors.push(0);
}

/**
 * A path's summaries of an interval, with `dimensions`. Every path read this interval has its state and readers; its
 * rates need two reads, so its first interval may have none.
 */
function metricsOf(samples: PathSamples, dimensions: Record<string, string>): Metric[] {
  const metrics = [
    summary(pathMetrics.ready, samples.ready, dimensions),
    summary(pathMetrics.readers, samples.readers, dimensions)
  ];
  if (samples.ingestBitrate.length > 0)
    metrics.push(summary(pathMetrics.ingestBitrate, samples.ingestBitrate, dimensions));
  if (samples.lanEgressBitrate.length > 0)
    metrics.push(summary(pathMetrics.lanEgressBitrate, samples.lanEgressBitrate, dimensions));
  if (samples.publisherEgressBitrate.length > 0)
    metrics.push(summary(pathMetrics.publisherEgressBitrate, samples.publisherEgressBitrate, dimensions));
  if (samples.frameErrors.length > 0)
    metrics.push(summary(pathMetrics.ingestFrameErrors, samples.frameErrors, dimensions));
  return metrics;
}

export interface MetricsStatus {
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

const STOPPED: MetricsStatus = {
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

/** Reads MediaMTX's metrics page every few seconds, and submits each path's summary to the studio API per interval. */
export class MediamtxMetricsRuntime {
  readonly status$ = new BehaviorSubject<MetricsStatus>(STOPPED);
  private readonly url: string;
  private readonly reporter: MetricReporter;
  private timer: ReturnType<typeof setInterval> | undefined = undefined;
  private sampleMs = SAMPLE_INTERVAL_MS;
  private intervalMs = 0;
  /** When the interval being sampled began, in milliseconds since the epoch. */
  private intervalStartedAt = 0;
  /** The last read, for the rates the next one moves at. */
  private previous: Read | undefined = undefined;
  /** Each path's samples since the last report. */
  private interval = new Map<string, PathSamples>();
  /** What each path's metrics are about, from the spec. */
  private index: PathIndex = null;
  /** Whether a tick's read, or a submission, is under way: a slow one skips the ticks it overlaps. */
  private ticking = false;
  private reporting = false;

  /** @param url The metrics page, such as `http://127.0.0.1:9998/metrics` (`reach.metrics`, reach.ts). */
  constructor(
    private readonly config: AgentConfiguration,
    url: string
  ) {
    this.url = url;
    this.reporter = new MetricReporter(config);
  }

  /**
   * Report each path's metrics about what `spec` says it delivers, from the next report on, including this interval's.
   * Only a changed interval starts reading afresh, so new paths keep the samples taken so far. Accepted as soon as
   * the timer is set; whether MediaMTX is up shows in each read.
   */
  async apply(spec: MetricsSpec): Promise<void> {
    if (this.config.type === 'direct') throw new Error('A direct agent has no studio API to report to');
    this.index = pathIndexOf(spec.paths);
    if (this.timer === undefined || spec.intervalMs !== this.intervalMs) this.start(spec.intervalMs);
  }

  /** Stop reading, and drop what was not submitted. Safe when it never started. */
  async teardown(): Promise<void> {
    this.clear();
    this.reporter.clear();
    this.update({ running: false, intervalMs: null });
  }

  /** Read every few seconds, and report every `intervalMs`, from now on. */
  private start(intervalMs: number): void {
    this.clear();
    this.update({ running: true, intervalMs });
    this.intervalMs = intervalMs;
    this.sampleMs = Math.min(SAMPLE_INTERVAL_MS, intervalMs);
    this.intervalStartedAt = Date.now();
    this.timer = setInterval(() => void this.tick(), this.sampleMs);
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
      const { read, samples } = await readMetricsPage(this.url);
      this.record(read);
      const at = new Date(read.at);
      this.update({ lastScrapedAt: at.toISOString(), samples });
    } catch (error) {
      this.update({ lastError: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Add a read's samples to each path's interval, and keep it for the next read's rates. */
  private record(read: Read): void {
    const previous = this.previous;
    const since = movedSince(read, previous);
    for (const [path, reading] of read.paths) {
      // A path in the read samples its state and readers, and its rates when the previous read had it too.
      const samples = this.interval.get(path) ?? emptySamples();
      this.interval.set(path, samples);
      samples.ready.push(reading.ready > 0 ? 1 : 0);
      samples.readers.push(reading.readers);
      const before = previous?.paths.get(path);
      if (since !== undefined && before !== undefined) addRates(samples, path, reading, before, since);
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
    const observedAt = now.toISOString();
    for (const [path, samples] of paths) {
      // A path the spec names is reported about its exposure; with no spec paths, any is about the device.
      const target: PathTarget | undefined =
        this.index === null ? { subjectId: undefined, dimensions: { path } } : this.index.get(path);
      if (target === undefined) continue;
      this.reporter.queue(observedAt, metricsOf(samples, target.dimensions), target.subjectId);
    }
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

  private update(change: Partial<MetricsStatus>): void {
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
