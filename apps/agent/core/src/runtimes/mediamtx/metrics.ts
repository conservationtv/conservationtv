import { type PrometheusSample, parseMetrics } from '@conservationtv/mediamtx';
import { pathMetrics } from '@conservationtv/reports';
import { map, type Observable } from 'rxjs';
import { z } from 'zod';
import type { AgentConfiguration } from '../../config.ts';
import { type MetricReporter, useMetricReporter } from '../reports.ts';
import { type IntervalSamples, Sampler, type SamplerStatus, type SeriesTarget } from '../sampler.ts';
import { type PathIndex, PathAttributionsSchema, pathIndexOf } from './paths.ts';

// The `metrics` key, fulfilled by MediaMTX's metrics, shipped to the studio API per path. On one timer, every few
// seconds, read its metrics page for each path's state, readers, and how fast its byte and frame-error counters moved
// since the last read; the read that ends an interval then submits each path's samples summarised (least, greatest,
// mean and last; runtimes/sampler.ts), so each path is a series of its own: about the exposure the spec says it
// delivers, with its rendition as a dimension, or, while the spec names no paths, about the agent's device with the
// path as the `path` dimension. A path the spec does not name is not reported. A path missing from a read counts as
// not ready with nothing flowing, so one that stops mid-interval shows in that interval's summary; one missing for a
// whole interval is not reported.
//
// What a path sends is split by who reads it. The agent's MoQ publishers read each path they publish over RTMP from
// loopback (builders/publishers.ts), all of it for as long as they run, so those readers' bytes are its publisher
// egress, and everything else it sends, to any other reader, its LAN egress. What actually reaches the relay is the
// relay's to count (runtimes/relay-traffic.ts). Per-session and per-protocol samples are not shipped.
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
  samples: IntervalSamples,
  path: string,
  reading: PathReading,
  before: PathReading,
  since: MovedSince
): void {
  const moved = reading.outboundBytes - before.outboundBytes;
  if (moved < 0) return;
  const total = (moved * 8) / since.seconds;
  const publishers = since.toPublishers.get(path) ?? 0;
  samples.add(path, pathMetrics.publisherEgressBitrate, Math.min(publishers, total));
  samples.add(path, pathMetrics.lanEgressBitrate, Math.max(total - publishers, 0));
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
function addRates(
  samples: IntervalSamples,
  path: string,
  reading: PathReading,
  before: PathReading,
  since: MovedSince
) {
  const ingest = samples.values(path, pathMetrics.ingestBitrate);
  addRate(ingest, reading.inboundBytes, before.inboundBytes, since.seconds, 8);
  addEgress(samples, path, reading, before, since);
  const errors = samples.values(path, pathMetrics.ingestFrameErrors);
  addRate(errors, reading.framesInError, before.framesInError, since.seconds, 1);
}

/** The metrics a path is sampled for, every one of them 0 once it has stopped. */
const PATH_METRICS = [
  pathMetrics.ready,
  pathMetrics.readers,
  pathMetrics.ingestBitrate,
  pathMetrics.lanEgressBitrate,
  pathMetrics.publisherEgressBitrate,
  pathMetrics.ingestFrameErrors
];

/** Sample a path missing from a read: it has stopped, so nothing is ready, read or flowing. */
function addStopped(samples: IntervalSamples, path: string): void {
  for (const metric of PATH_METRICS) samples.add(path, metric, 0);
}

/** What reading the metrics page adds to its sampler's status. */
interface MetricsReads {
  intervalMs: number | null;
  /** The subject the reports are about, once the studio API has said which device the agent is. */
  subjectId: string | null;
  /** ISO 8601. */
  lastScrapedAt: string | null;
  /** How many samples the last read found. */
  samples: number;
}

export type MetricsStatus = SamplerStatus & MetricsReads;

const SCRAPE_TIMEOUT_MS = 5_000;

/** Reads MediaMTX's metrics page every few seconds, and submits each path's summary to the studio API per interval. */
export class MediamtxMetricsRuntime {
  readonly status$: Observable<MetricsStatus>;
  private readonly url: string;
  private readonly reporter: MetricReporter;
  private readonly sampler: Sampler<MetricsReads>;
  private intervalMs = 0;
  /** The last read, for the rates the next one moves at. */
  private previous: Read | undefined = undefined;
  /** What each path's metrics are about, from the spec. */
  private index: PathIndex = null;

  /** @param url The metrics page, such as `http://127.0.0.1:9998/metrics` (`reach.metrics`, reach.ts). */
  constructor(
    private readonly config: AgentConfiguration,
    url: string
  ) {
    this.url = url;
    this.reporter = useMetricReporter();
    this.sampler = new Sampler<MetricsReads>({
      stopped: { intervalMs: null, subjectId: null, lastScrapedAt: null, samples: 0 },
      sample: samples => this.sample(samples),
      target: path => this.targetOf(path)
    });
    // Whichever of the agent's monitors asks first, the device the reports are about shows once it is known.
    const withSubject = map((status: MetricsStatus) => ({ ...status, subjectId: this.reporter.subjectId }));
    this.status$ = this.sampler.status$.pipe(withSubject);
  }

  /**
   * Report each path's metrics about what `spec` says it delivers, from the next report on, including this interval's.
   * Only a changed interval starts reading afresh, so new paths keep the samples taken so far. Accepted as soon as
   * the timer is set; whether MediaMTX is up shows in each read.
   */
  async apply(spec: MetricsSpec): Promise<void> {
    if (this.config.type === 'direct') throw new Error('A direct agent has no studio API to report to');
    this.index = pathIndexOf(spec.paths);
    if (!this.sampler.running || spec.intervalMs !== this.intervalMs) this.start(spec.intervalMs);
  }

  /** Stop reading, and drop what was not submitted. Safe when it never started. */
  async teardown(): Promise<void> {
    this.previous = undefined;
    this.sampler.stop();
    this.sampler.update({ intervalMs: null });
  }

  /** Read every few seconds, and report every `intervalMs`, from now on. */
  private start(intervalMs: number): void {
    this.previous = undefined;
    this.intervalMs = intervalMs;
    this.sampler.start({ sampleMs: Math.min(SAMPLE_INTERVAL_MS, intervalMs), reportMs: intervalMs });
    this.sampler.update({ intervalMs });
  }

  /** Stop the timer for good when the agent stops; not a removal, so the status is left as it was. */
  dispose(): void {
    this.sampler.dispose();
  }

  /** Read the metrics page into each path's samples. A failed read throws, for the status, and is skipped. */
  private async sample(samples: IntervalSamples): Promise<void> {
    const page = await readMetricsPage(this.url);
    this.record(samples, page.read);
    const at = new Date(page.read.at);
    this.sampler.update({ lastScrapedAt: at.toISOString(), samples: page.samples });
  }

  /** Add a read's samples to each path's interval, and keep it for the next read's rates. */
  private record(samples: IntervalSamples, read: Read): void {
    const previous = this.previous;
    const since = movedSince(read, previous);
    // A path seen this interval but missing from the read has stopped.
    for (const path of samples.keys()) if (!read.paths.has(path)) addStopped(samples, path);
    for (const [path, reading] of read.paths) {
      // A path in the read samples its state and readers, and its rates when the previous read had it too.
      samples.add(path, pathMetrics.ready, reading.ready > 0 ? 1 : 0);
      samples.add(path, pathMetrics.readers, reading.readers);
      const before = previous?.paths.get(path);
      if (since !== undefined && before !== undefined) addRates(samples, path, reading, before, since);
    }
    this.previous = read;
  }

  /** A path the spec names is reported about its exposure; with no spec paths, any is about the device. */
  private targetOf(path: string): SeriesTarget | undefined {
    if (this.index === null) return { subjectId: undefined, dimensions: { path } };
    return this.index.get(path);
  }
}
