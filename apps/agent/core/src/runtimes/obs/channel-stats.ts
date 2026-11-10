import { channelMetrics, channelSubject, type MetricDefinition } from '@conservationtv/reports';
import type { Client } from '@conservationtv/studio-sdk';
import { BehaviorSubject } from 'rxjs';
import type { AgentConfiguration } from '../../config.ts';
import { type Metric, MetricReporter, summary } from '../reports.ts';

// What the platforms say of the channels a show goes out to, from the output agent, as the relays' traffic is read
// for the exposures an agent publishes (runtimes/mediamtx/relay-traffic.ts): every few seconds, each channel the
// configuration says has stats is read with `organisations.channels.stats.get`, signed as the device, which reads the
// platform (Twitch's Helix) itself, so the connection's tokens never reach the agent; every interval, each channel's
// samples are summarised and submitted about `channel:<channelId>`:
//
//   channel.live     whether the platform says the channel is live;
//   channel.viewers  how many watch it, as the platform counts them, 0 while it is offline;
//   channel.uptime   how long it has been live, by the platform's start time, only while it is.
//
// A read that fails samples nothing: a gap, not zeroes. The platform counts viewers itself, so a channel reads as live
// with its viewers whoever sends to it: the show's forward, or anything else streaming to the channel.

/**
 * How often each channel is read. Twitch updates a stream's viewer count about once a minute, and each read is a call
 * to the studio API and one from it to Twitch, so more often than this learns nothing.
 */
const SAMPLE_INTERVAL_MS = 30_000;

/** How often each channel's summary is submitted, as the program's are. */
const REPORT_INTERVAL_MS = 60_000;

/** A channel to report about: one the show forwards to that has stats. */
export interface ReportedChannel {
  organisationId: string;
  channelId: string;
}

export interface ChannelStatsStatus {
  /** Whether the channels are being read. */
  running: boolean;
  /** How many channels are read. */
  channels: number;
  /** ISO 8601: when a channel was last read. */
  lastReadAt: string | null;
  /** Metrics read but not yet accepted. */
  pending: number;
  /** Metrics accepted since the agent started. */
  submitted: number;
  /** ISO 8601. */
  lastSubmittedAt: string | null;
  /** Why the last read or submission failed; cleared by the next submission. */
  lastError: string | null;
}

const STOPPED: ChannelStatsStatus = {
  running: false,
  channels: 0,
  lastReadAt: null,
  pending: 0,
  submitted: 0,
  lastSubmittedAt: null,
  lastError: null
};

/** What `organisations.channels.stats.get` says of a channel. */
type ChannelStatsRead = Exclude<Awaited<ReturnType<Client['organisations']['channels']['stats']['get']['v1']>>, Error>;

/** Each metric's samples this interval, by its definition. */
type Samples = Map<MetricDefinition, number[]>;

/** Reads each channel's stats every few seconds, and submits each channel's summary to the studio API per interval. */
export class ChannelStats {
  readonly status$ = new BehaviorSubject<ChannelStatsStatus>(STOPPED);
  private readonly reporter: MetricReporter;
  private channels: ReportedChannel[] = [];
  private timer: ReturnType<typeof setInterval> | undefined = undefined;
  private intervalStartedAt = 0;
  /** Each channel's samples since the last report, by its subject. */
  private interval = new Map<string, Samples>();
  private ticking = false;
  private reporting = false;

  constructor(
    config: AgentConfiguration,
    private readonly studio: Client
  ) {
    this.reporter = new MetricReporter(config);
  }

  /** Read `channels` from now on: the timer starts for some, and stops for none. */
  apply(channels: ReportedChannel[]): void {
    this.channels = channels;
    this.update({ channels: channels.length });
    if (channels.length === 0) {
      this.stop();
      return;
    }
    if (this.timer !== undefined) return;
    this.intervalStartedAt = Date.now();
    this.timer = setInterval(() => void this.tick(), SAMPLE_INTERVAL_MS);
    this.update({ running: true });
  }

  /** Stop reading, and drop what was not submitted. */
  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.channels = [];
    this.interval = new Map();
    this.reporter.clear();
    this.update({ running: false, channels: 0, pending: 0 });
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

  /** Read each channel in turn into its interval: one that can't be read samples nothing this time. */
  private async sample(): Promise<void> {
    for (const channel of this.channels) {
      try {
        const stats = await this.read(channel);
        this.sampleChannel(channelSubject(channel.channelId), stats);
        this.update({ lastReadAt: stats.observedAt });
      } catch (error) {
        this.update({ lastError: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  /** What the channel's platform says now, as the device. */
  private async read(channel: ReportedChannel): Promise<ChannelStatsRead> {
    const stats = await this.studio.organisations.channels.stats.get.v1({
      id: channel.organisationId,
      channelId: channel.channelId
    });
    if (stats instanceof Error) throw stats;
    return stats;
  }

  /** One read of a channel: live, its viewers (none while offline), and how long it has been live while it is. */
  private sampleChannel(subject: string, stats: ChannelStatsRead): void {
    this.add(subject, channelMetrics.live, stats.live ? 1 : 0);
    this.add(subject, channelMetrics.viewers, stats.live ? stats.viewers : 0);
    if (!stats.live) return;
    const seconds = (Date.parse(stats.observedAt) - Date.parse(stats.startedAt)) / 1000;
    if (Number.isFinite(seconds)) this.add(subject, channelMetrics.uptime, Math.max(0, seconds));
  }

  /** Add one sample of `metric` about `subject` to this interval. */
  private add(subject: string, metric: MetricDefinition, value: number): void {
    const samples = this.interval.get(subject) ?? new Map<MetricDefinition, number[]>();
    this.interval.set(subject, samples);
    const values = samples.get(metric) ?? [];
    samples.set(metric, values);
    values.push(value);
  }

  /** Submit each channel's summary of the interval, and start the next. */
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

  private update(changes: Partial<ChannelStatsStatus>): void {
    this.status$.next({ ...this.status$.value, ...changes });
  }
}
