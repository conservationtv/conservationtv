import { channelMetrics, channelSubject } from '@conservationtv/reports';
import type { Client } from '@conservationtv/studio-sdk';
import type { BehaviorSubject } from 'rxjs';
import { z } from 'zod';
import { useStudio } from '../studio.ts';
import { type IntervalSamples, Sampler, type SamplerStatus } from './sampler.ts';

// The `channels` key: what the platforms say of the channels a show goes out to, as the relays' traffic is read for
// the exposures an agent publishes (relay-traffic.ts). Every few seconds, each channel the spec names is read with
// `organisations.channels.stats.get`, signed as the device, which reads the platform (Twitch's Helix) itself, so the
// connection's tokens never reach the agent; every interval, each channel's samples are summarised and submitted about
// `channel:<channelId>` (sampler.ts):
//
//   channel.live     whether the platform says the channel is live;
//   channel.viewers  how many watch it, as the platform counts them, 0 while it is offline;
//   channel.uptime   how long it has been live, by the platform's start time, only while it is.
//
// The spec is the channels the show forwards to that have stats (studio-configuration.ts). Nothing here needs OBS, so
// the channels are read whether or not the `obs` key's OBS is up, or can run on the machine at all.
//
// A read that fails samples nothing: a gap, not zeroes. The platform counts viewers itself, so a channel reads as live
// with its viewers whoever sends to it: the show's forward, or anything else streaming to the channel.

/** A channel to report about: one the show forwards to that has stats. */
const ReportedChannelSchema = z.object({
  organisationId: z.string(),
  channelId: z.string()
});
export type ReportedChannel = z.output<typeof ReportedChannelSchema>;

/** The channels whose platforms to read. */
export const ChannelsSpecSchema = z.object({
  /** Each channel to read, once. */
  channels: z.array(ReportedChannelSchema)
});
export type ChannelsSpec = z.output<typeof ChannelsSpecSchema>;

/**
 * How often each channel is read. Twitch updates a stream's viewer count about once a minute, and each read is a call
 * to the studio API and one from it to Twitch, so more often than this learns nothing.
 */
const SAMPLE_INTERVAL_MS = 30_000;

/** How often each channel's summary is submitted, as the program's are. */
const REPORT_INTERVAL_MS = 60_000;

/** What the channels' reads add to their sampler's status. */
interface ChannelReads {
  /** How many channels are read. */
  channels: number;
  /** ISO 8601: when a channel was last read. */
  lastReadAt: string | null;
}

export type ChannelStatsStatus = SamplerStatus & ChannelReads;

/** What `organisations.channels.stats.get` says of a channel. */
type ChannelStatsRead = Exclude<Awaited<ReturnType<Client['organisations']['channels']['stats']['get']['v1']>>, Error>;

/** Reads each channel's stats every few seconds, and submits each channel's summary to the studio API per interval. */
export class ChannelStatsRuntime {
  readonly status$: BehaviorSubject<ChannelStatsStatus>;
  private readonly sampler: Sampler<ChannelReads>;
  private readonly studio: Client;
  private channels: ReportedChannel[] = [];

  constructor() {
    this.studio = useStudio();
    this.sampler = new Sampler<ChannelReads>({
      stopped: { channels: 0, lastReadAt: null },
      sample: samples => this.sample(samples)
    });
    this.status$ = this.sampler.status$;
  }

  /** Read the spec's channels from now on: the timer starts for some, and stops for none. */
  async apply(spec: ChannelsSpec): Promise<void> {
    const { channels } = spec;
    this.channels = channels;
    this.sampler.update({ channels: channels.length });
    if (channels.length === 0) return this.teardown();
    if (!this.sampler.running) this.sampler.start({ sampleMs: SAMPLE_INTERVAL_MS, reportMs: REPORT_INTERVAL_MS });
  }

  /** Stop reading, and drop what was not submitted. Safe when it never started. */
  async teardown(): Promise<void> {
    this.channels = [];
    this.sampler.stop();
    this.sampler.update({ channels: 0 });
  }

  /** Stop the timer for good when the agent stops; not a removal, so the status is left as it was. */
  dispose(): void {
    this.sampler.dispose();
  }

  /** Read each channel in turn into its interval: one that can't be read samples nothing this time. */
  private async sample(samples: IntervalSamples): Promise<void> {
    for (const channel of this.channels) {
      try {
        const stats = await this.read(channel);
        sampleChannel(samples, channelSubject(channel.channelId), stats);
        this.sampler.update({ lastReadAt: stats.observedAt });
      } catch (error) {
        this.sampler.failed(error instanceof Error ? error.message : String(error));
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
}

/** One read of a channel: live, its viewers (none while offline), and how long it has been live while it is. */
function sampleChannel(samples: IntervalSamples, subject: string, stats: ChannelStatsRead): void {
  samples.add(subject, channelMetrics.live, stats.live ? 1 : 0);
  samples.add(subject, channelMetrics.viewers, stats.live ? stats.viewers : 0);
  if (!stats.live) return;
  const seconds = (Date.parse(stats.observedAt) - Date.parse(stats.startedAt)) / 1000;
  if (Number.isFinite(seconds)) samples.add(subject, channelMetrics.uptime, Math.max(0, seconds));
}
