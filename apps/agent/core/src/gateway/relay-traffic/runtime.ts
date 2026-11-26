import { exposureSubject, relayMetrics } from '@conservationtv/reports';
import type { BehaviorSubject } from 'rxjs';
import { z } from 'zod';
import { type IntervalSamples, REPORT_INTERVAL_MS, Sampler, type SamplerStatus } from '../../reporting/sampler.ts';
import { RelayCheck } from '../streams/relay-check.ts';
import { type Counters, followStats, type Role, type Traffic, type TrafficEntry } from './follow.ts';

// The `relayTraffic` key: what the MoQ relays carry of the exposures the agent covers, as the relays count it. Each
// relay node publishes its traffic stats for the organisation as a broadcast, `node/<node>`, beneath the stats path the
// studio API hands out (`organisations.gateways.stats.connect`), with a pair of tracks per tier of session:
// `subscriber.json`, what the node received, and `publisher.json`, what it sent, each a JSON object of cumulative
// counters by broadcast path. Only the consumer tier's count: the sessions publishers and viewers hold, rather than the
// relays' own peering. The agent follows every node's, samples every few seconds how fast the counters of each
// exposure's broadcasts (those beneath its prefix) moved, and each interval submits each exposure's summary
// (reporting/sampler.ts): what the relays received of it, which is what actually left this agent for the internet, what they
// sent on to its viewers, and how many watch.
//
// The spec says where to read the stats, each URL carrying its token, and each exposure by the path its broadcasts
// are beneath on the relay (gateway/configuration.ts, from the `streams` key's publishers and the exposures it
// watches), so the publishers' own URLs and tokens never reach it. With no exposures the relays are still followed, and
// nothing is reported.
//
// The agent covers some exposures it does not publish: one a browser publishes straight to the relay, or one nobody
// else covers (docs/shows.md, Health and stats without an agent). For each it is told where to read it (`watched`), and
// reads its catalog back through the relay, as the `streams` key does for each exposure it publishes
// (streams/relay-check.ts): that says whether the relay has it (`relay.announced`), which for these is whether anyone
// is publishing it at all, since what the relay carries depends on who watches. A renewed watch is the same check, read
// with the new token (relay-check.ts), so it is never taken for the exposure going. A renewed stats token is a new URL: it is followed afresh and the old one stopped, which takes each node's counters with it
// until the new connection's first frame, so the sample or two after a renewal have no rates. The rest of that
// interval's samples still make its summary.

/** Where to read a relay's traffic stats: the URL to dial, carrying its token as `?jwt=`. */
const RelayStatsSourceSchema = z.object({ connect: z.url() });
export type RelayStatsSource = z.output<typeof RelayStatsSourceSchema>;

/** An exposure the agent publishes, by the path its broadcasts are beneath on the relay, with its trailing slash. */
const ExposurePathSchema = z.object({ exposureId: z.string(), prefix: z.string() });
type ExposurePath = z.output<typeof ExposurePathSchema>;

/**
 * An exposure the agent covers but does not publish, to watch on the relay: the URL to dial, carrying its read token
 * as `?jwt=`, and its broadcast there.
 */
const WatchedBroadcastSchema = z.object({ exposureId: z.string(), connect: z.url(), broadcast: z.string().min(1) });
export type WatchedBroadcast = z.output<typeof WatchedBroadcastSchema>;

/** The relays' stats to read, the exposures to report what they carry of, and those to watch there. */
export const RelayTrafficSpecSchema = z.object({
  /** Each relay's stats, followed while it is named. */
  sources: z.array(RelayStatsSourceSchema),
  /** The exposures to report about, each by the path its broadcasts are beneath on the relay. */
  exposures: z.array(ExposurePathSchema),
  /** The exposures it covers but does not publish, each watched on the relay while it is named. */
  watched: z.array(WatchedBroadcastSchema).default([])
});
export type RelayTrafficSpec = z.output<typeof RelayTrafficSpecSchema>;

/** How often the counters are sampled; each exposure's summary is submitted every `REPORT_INTERVAL_MS`. */
const SAMPLE_MS = 5_000;

/** What following the relays adds to their sampler's status. */
interface RelayReads {
  /** How many stats sources are followed. */
  sources: number;
  /** How many relay nodes' counters there are. */
  nodes: number;
  /** ISO 8601: when the counters were last sampled. */
  lastSampledAt: string | null;
}

export type RelayTrafficStatus = SamplerStatus & RelayReads;

/**
 * Reports what the relays carry of the exposures the agent covers, from the stats each relay node publishes, and
 * whether the relay has each it watches.
 */
export class RelayTrafficRuntime {
  readonly status$: BehaviorSubject<RelayTrafficStatus>;
  private readonly sampler: Sampler<RelayReads>;
  private readonly relayCheck = new RelayCheck();
  /** Each stats source being followed, by its URL, with how to stop following it. */
  private readonly sources = new Map<string, () => void>();
  private readonly counters: Counters = new Map();
  private paths: ExposurePath[] = [];
  private previous: Counters | undefined = undefined;
  private previousAt = 0;

  constructor() {
    this.sampler = new Sampler<RelayReads>({
      stopped: { sources: 0, nodes: 0, lastSampledAt: null },
      sample: samples => this.sample(samples)
    });
    this.status$ = this.sampler.status$;
  }

  /**
   * Follow the stats at each of the spec's sources, report about each of its exposures, and watch each it names to
   * watch. A source or watch no longer given is stopped; a source that is new (as a renewed token is) is started
   * afresh, and a watch with a renewed token carries on with it.
   */
  async apply(spec: RelayTrafficSpec): Promise<void> {
    this.relayCheck.set(spec.watched);
    this.follow(spec.sources.map(({ connect }) => connect));
    this.paths = spec.exposures;
    this.sampler.update({ sources: this.sources.size });
    if (this.sources.size === 0) return this.stopSampling();
    if (this.sampler.running) return;
    this.previous = undefined;
    this.sampler.start({ sampleMs: SAMPLE_MS, reportMs: REPORT_INTERVAL_MS });
  }

  /** Stop following every source and watching every exposure, and drop what was not submitted. Safe when it never started. */
  async teardown(): Promise<void> {
    this.relayCheck.close();
    this.stopSampling();
  }

  /** Stop following every source, and drop what was not submitted. */
  private stopSampling(): void {
    this.follow([]);
    this.paths = [];
    this.previous = undefined;
    this.sampler.stop();
    this.sampler.update({ sources: 0, nodes: 0 });
  }

  /** Stop following and sampling for good when the agent stops; not a removal, so the status is left as it was. */
  dispose(): void {
    this.follow([]);
    this.relayCheck.dispose();
    this.sampler.dispose();
  }

  /** Follow the stats at each of `urls`, and only those. */
  private follow(urls: string[]): void {
    for (const [url, stop] of this.sources) {
      if (urls.includes(url)) continue;
      stop();
      this.sources.delete(url);
    }
    for (const url of urls) if (!this.sources.has(url)) this.sources.set(url, followStats(url, this.counters));
  }

  /** Sample each exposure's rates since the last sample. */
  private sample(samples: IntervalSamples): void {
    const now = Date.now();
    const snapshot = copyCounters(this.counters);
    const previous = this.previous;
    if (previous !== undefined) {
      const seconds = (now - this.previousAt) / 1000;
      for (const path of this.paths) addSamples(samples, path, snapshot, previous, seconds);
    }
    this.previous = snapshot;
    this.previousAt = now;
    const at = new Date(now);
    this.sampler.update({ nodes: snapshot.size, lastSampledAt: at.toISOString() });
  }
}

/** Add an exposure's rates to its interval, each only when some node had its stats at both samples. */
function addSamples(
  samples: IntervalSamples,
  path: ExposurePath,
  snapshot: Counters,
  previous: Counters,
  seconds: number
): void {
  const subject = exposureSubject(path.exposureId);
  const received = rate(snapshot, previous, 'received', path, seconds);
  const sent = rate(snapshot, previous, 'sent', path, seconds);
  if (received !== undefined) samples.add(subject, relayMetrics.ingestBitrate, received);
  if (sent !== undefined) samples.add(subject, relayMetrics.egressBitrate, sent);
  if (sent !== undefined) samples.add(subject, relayMetrics.viewers, viewers(snapshot, path));
}

/** The counters as they are now: each node's tracks are replaced whole as frames arrive, so a shallow copy holds. */
function copyCounters(counters: Counters): Counters {
  return new Map([...counters].map(([node, roles]) => [node, new Map(roles)]));
}

/**
 * Bits a second the exposure's broadcasts moved in `role` between two samples, summed over the nodes that had stats
 * at both: undefined when none did. A broadcast new since the previous sample counts from zero; one whose count went
 * back was reset, as by a relay restart, and gives nothing.
 */
function rate(
  snapshot: Counters,
  previous: Counters,
  role: Role,
  path: ExposurePath,
  seconds: number
): number | undefined {
  let bits: number | undefined = undefined;
  for (const [node, roles] of snapshot) {
    // Only a node with stats in both samples has moved since one: a node's first frame gives no rate.
    const now = roles.get(role);
    const before = previous.get(node)?.get(role);
    if (now === undefined || before === undefined) continue;
    bits = (bits ?? 0) + movedBits(now, before, path);
  }
  return bits === undefined ? undefined : bits / seconds;
}

/** The bits the exposure's broadcasts moved between two of a node's frames. */
function movedBits(now: Traffic, before: Traffic, path: ExposurePath): number {
  let bytes = 0;
  for (const [broadcast, entry] of Object.entries(now)) {
    // Only the exposure's broadcasts, and only what they moved: a broadcast new since counts from zero, a reset nothing.
    if (!broadcast.startsWith(path.prefix)) continue;
    const moved = entry.bytes - (before[broadcast]?.bytes ?? 0);
    if (moved > 0) bytes += moved;
  }
  return bytes * 8;
}

/** How many sessions watch the exposure: of its broadcasts on each node, the most watched, summed over nodes. */
function viewers(snapshot: Counters, path: ExposurePath): number {
  let total = 0;
  for (const roles of snapshot.values()) {
    const sent = roles.get('sent') ?? {};
    const watching = Object.entries(sent)
      .filter(([broadcast]) => broadcast.startsWith(path.prefix))
      .map(([, entry]) => watchingOf(entry));
    total += Math.max(0, ...watching);
  }
  return total;
}

/** The sessions watching one broadcast: started less ended, the canonical counters first, then the legacy ones. */
function watchingOf(entry: TrafficEntry): number {
  const started = entry.broadcasts_started ?? entry.broadcasts ?? 0;
  const ended = entry.broadcasts_ended ?? entry.broadcasts_closed ?? 0;
  return Math.max(0, started - ended);
}
