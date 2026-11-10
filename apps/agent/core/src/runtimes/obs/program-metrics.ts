import { forwardMetrics, previewMetrics, programMetrics, recorderMetrics } from '@conservationtv/reports';
import type { BehaviorSubject } from 'rxjs';
import {
  addRate,
  type ForwardReading,
  forwardRates,
  publisherRates,
  type Read,
  readMetricsPage
} from '../mediamtx/metrics.ts';
import { type IntervalSamples, Sampler, type SamplerStatus } from '../sampler.ts';
import { PROGRAM_PATH } from './program.ts';
import type { ObsReading } from './streaming.ts';

// The program's reports, from the output agent: every few seconds, a read of the program MediaMTX's metrics page
// (as the gateway MediaMTX's is read, runtimes/mediamtx/metrics.ts) and the watchdog's latest read of obs-websocket
// (streaming.ts); every interval, each subject's samples summarised (least, greatest, mean and last) and submitted
// (runtimes/sampler.ts):
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

/** What reading the program adds to its sampler's status. */
interface ProgramReads {
  /** ISO 8601. */
  lastScrapedAt: string | null;
}

export type ProgramMetricsStatus = SamplerStatus & ProgramReads;

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

/** Reads the program and OBS every few seconds, and submits each subject's summary to the studio API per interval. */
export class ProgramMetrics {
  readonly status$: BehaviorSubject<ProgramMetricsStatus>;
  private readonly sampler: Sampler<ProgramReads>;
  private subjects: ProgramSubjects | undefined = undefined;
  /** The last reads, for the rates the next ones move at. */
  private previous: Read | undefined = undefined;
  private previousObs: ObsReading | undefined = undefined;

  /** @param obs The watchdog's latest read of OBS, or null while it doesn't answer. */
  constructor(
    private readonly source: ProgramSource,
    private readonly obs: () => ObsReading | null
  ) {
    this.sampler = new Sampler<ProgramReads>({
      stopped: { lastScrapedAt: null },
      sample: samples => this.sample(samples)
    });
    this.status$ = this.sampler.status$;
  }

  /** Report about `subjects` from now on, starting the timer if it isn't running. */
  apply(subjects: ProgramSubjects): void {
    this.subjects = subjects;
    if (this.sampler.running) return;
    this.sampler.start({ sampleMs: SAMPLE_INTERVAL_MS, reportMs: REPORT_INTERVAL_MS });
  }

  /** Stop reading, and drop what was not submitted. */
  stop(): void {
    this.subjects = undefined;
    this.previous = undefined;
    this.previousObs = undefined;
    this.sampler.stop();
  }

  /**
   * Sample OBS's latest reading, then the program MediaMTX's metrics page, into each subject's interval. A read of
   * the page that fails throws, for the status, having sampled OBS's.
   */
  private async sample(samples: IntervalSamples): Promise<void> {
    const subjects = this.subjects;
    if (subjects === undefined) return;
    this.sampleObs(samples, subjects);
    const { read } = await readMetricsPage(this.source.metricsUrl);
    const previous = this.previous;
    // Rates move between this read and the previous one, so there are none on the first.
    const seconds = previous === undefined ? 0 : (read.at - previous.at) / 1000;
    const since = previous === undefined || seconds <= 0 ? undefined : { previous, seconds };
    sampleProgram(samples, subjects.program, read, since);
    this.sampleDestinations(samples, read, since);
    this.sampleMoqPreviews(samples, read, since);
    this.previous = read;
    const at = new Date(read.at);
    this.sampler.update({ lastScrapedAt: at.toISOString() });
  }

  /**
   * Each forward destination of `show/program`, about the subject its place in the list says: connected while it is
   * forwarding, and what it was sent since the previous read, nothing while it has no destination in the read.
   */
  private sampleDestinations(samples: IntervalSamples, read: Read, since: Since | undefined): void {
    const rates = since === undefined ? undefined : forwardRates(read, since.previous, since.seconds);
    const destinations = this.source.destinations();
    for (const [index, destination] of destinations.entries()) {
      if (destination !== undefined) sampleDestination(samples, destination, forwardAt(read, index + 1), rates);
    }
  }

  /** Each preview published by MoQ: its CLI's read of the preview's path, from loopback. */
  private sampleMoqPreviews(samples: IntervalSamples, read: Read, since: Since | undefined): void {
    const rates = since === undefined ? undefined : publisherRates(read, since.previous, since.seconds);
    const reading = new Set<string>();
    for (const publisher of read.publishers.values()) reading.add(publisher.path);
    const previews = this.source.moqPreviews();
    for (const [path, subject] of previews) {
      samples.add(subject, previewMetrics.connected, reading.has(path) ? 1 : 0);
      if (rates !== undefined) samples.add(subject, previewMetrics.egressBitrate, rates.get(path) ?? 0);
    }
  }

  /** OBS's latest reading, once: its frame rate, skipped frames, its stream's state, and its recording's. */
  private sampleObs(samples: IntervalSamples, subjects: ProgramSubjects): void {
    const reading = this.obs();
    if (reading === null || reading.at === this.previousObs?.at) return;
    const previous = this.previousObs;
    this.previousObs = reading;
    const { stats, stream, record } = reading;
    const subject = subjects.program;
    samples.add(subject, programMetrics.fps, stats.activeFps);
    samples.add(subject, programMetrics.congestion, stream.outputCongestion);
    samples.add(subject, programMetrics.reconnecting, stream.outputReconnecting ? 1 : 0);
    if (previous !== undefined) sampleSkipped(samples, subject, reading, previous);
    if (subjects.recorder === undefined || record === undefined) return;
    samples.add(subjects.recorder, recorderMetrics.active, record.outputActive ? 1 : 0);
    samples.add(subjects.recorder, recorderMetrics.bytes, record.outputBytes);
  }
}

/** `show/program`: ready, what it receives, and whether OBS publishes to it or the offline segment plays. */
function sampleProgram(samples: IntervalSamples, subject: string, read: Read, since: Since | undefined): void {
  const reading = read.paths.get(PROGRAM_PATH);
  const ready = reading?.ready ?? 0;
  samples.add(subject, programMetrics.ready, ready > 0 ? 1 : 0);
  samples.add(subject, programMetrics.fallback, read.rtmpPublished.has(PROGRAM_PATH) ? 0 : 1);
  const before = since?.previous.paths.get(PROGRAM_PATH);
  if (reading === undefined || before === undefined || since === undefined) return;
  const values = samples.values(subject, programMetrics.ingestBitrate);
  addRate(values, reading.inboundBytes, before.inboundBytes, since.seconds, 8);
}

/** One forward destination, as `found` in the read, if it is, with what each destination was sent since the last. */
function sampleDestination(
  samples: IntervalSamples,
  destination: ProgramDestination,
  found: FoundForward | undefined,
  rates: Map<string, number> | undefined
): void {
  const { kind, subject } = destination;
  const metrics = kind === 'preview' ? previewMetrics : forwardMetrics;
  samples.add(subject, metrics.connected, found?.reading.state === 'forwarding' ? 1 : 0);
  if (rates === undefined) return;
  // One missing from the read was sent nothing; one whose count went back gives no rate.
  const rate = found === undefined ? 0 : rates.get(found.id);
  if (rate !== undefined) samples.add(subject, metrics.egressBitrate, rate);
}

/** How many frames a second OBS skipped rendering and encoding between two readings. */
function sampleSkipped(samples: IntervalSamples, subject: string, reading: ObsReading, previous: ObsReading): void {
  const seconds = (reading.at - previous.at) / 1000;
  if (seconds <= 0) return;
  const { stats } = reading;
  const render = samples.values(subject, programMetrics.renderSkipped);
  addRate(render, stats.renderSkippedFrames, previous.stats.renderSkippedFrames, seconds, 1);
  const output = samples.values(subject, programMetrics.outputSkipped);
  addRate(output, stats.outputSkippedFrames, previous.stats.outputSkippedFrames, seconds, 1);
}
