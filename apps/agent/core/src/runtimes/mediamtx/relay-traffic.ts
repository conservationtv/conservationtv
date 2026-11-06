import { relayMetrics } from '@conservationtv/reports';
import { getLogger } from '@logtape/logtape';
import * as Moq from '@moq/net';
import { z } from 'zod';
import type { AgentConfiguration } from '../../config.ts';
import { type Metric, MetricReporter, summary } from '../reports.ts';
import type { MoqPublisher } from './config.ts';

const logger = getLogger(['agent', 'mediamtx', 'relay-traffic']);

// What the MoQ relays carry of the exposures the agent publishes, as the relays count it. Each relay node publishes its
// traffic stats for the organisation as a broadcast, `node/<node>`, beneath the stats path the studio API hands out
// (`organisations.gateways.stats.connect`), with a pair of tracks per tier of session: `subscriber.json`, what the node
// received, and `publisher.json`, what it sent, each a JSON object of cumulative counters by broadcast path. Only the
// consumer tier's count: the sessions publishers and viewers hold, rather than the relays' own peering. The agent
// follows every node's, samples every few seconds how fast the counters of each exposure's broadcasts (those beneath
// the path it publishes the exposure at) moved, and each interval submits each exposure's summary: what the relays
// received of it, which is what actually left this agent for the internet, what they sent on to its viewers, and how
// many watch.

/** How often the counters are sampled, and each exposure's summary submitted. */
const SAMPLE_MS = 10_000;
const REPORT_MS = 60_000;
/** How long to wait before following a node's stats again, after its subscription failed or ended. */
const RESUBSCRIBE_MS = 1_000;

/** One broadcast's counters, as a relay node publishes them: a missing counter is zero, and legacy spellings count. */
const TrafficEntrySchema = z.object({
  bytes: z.number().default(0),
  broadcasts_started: z.number().optional(),
  broadcasts_ended: z.number().optional(),
  broadcasts: z.number().optional(),
  broadcasts_closed: z.number().optional()
});
type TrafficEntry = z.output<typeof TrafficEntrySchema>;
const TrafficSchema = z.record(z.string(), TrafficEntrySchema);
type Traffic = z.output<typeof TrafficSchema>;

/** Which way traffic went, by the track a node publishes it on: what it received, and what it sent. */
const ROLE_TRACKS = { received: 'consumer/subscriber.json', sent: 'consumer/publisher.json' } as const;
type Role = keyof typeof ROLE_TRACKS;
const ROLES: Role[] = ['received', 'sent'];

/** Each node's latest counters, by the relay and node they are from, and by role. */
type Counters = Map<string, Map<Role, Traffic>>;

/** An exposure the agent publishes, by the path its broadcasts are beneath on the relay, with its trailing slash. */
interface ExposurePath {
  exposureId: string;
  prefix: string;
}

/** An exposure's samples so far this interval: bitrates in bits a second, and viewers. */
interface ExposureSamples {
  received: number[];
  sent: number[];
  viewers: number[];
}

/** Reports what the relays carry of the exposures the agent publishes, from the stats each relay node publishes. */
export class RelayTrafficReporter {
  private readonly reporter: MetricReporter;
  /** Each stats source being followed, by its URL, with how to stop following it. */
  private readonly sources = new Map<string, () => void>();
  private readonly counters: Counters = new Map();
  private paths: ExposurePath[] = [];
  private previous: Counters | undefined = undefined;
  private previousAt = 0;
  private interval = new Map<string, ExposureSamples>();
  private intervalStartedAt = 0;
  private timer: ReturnType<typeof setInterval> | undefined = undefined;
  private reporting = false;

  constructor(config: AgentConfiguration) {
    this.reporter = new MetricReporter(config);
  }

  /**
   * Follow the stats at each of `sources`, URLs to dial carrying their tokens, and report about each of `publishers`'
   * exposures. A source no longer given is stopped; one that is new (as a renewed token is) is followed afresh.
   */
  set(sources: string[], publishers: MoqPublisher[]): void {
    this.paths = publishers.map(({ exposureId, connect }) => ({ exposureId, prefix: `${pathOf(connect)}/` }));
    for (const [url, stop] of this.sources) {
      if (sources.includes(url)) continue;
      stop();
      this.sources.delete(url);
    }
    for (const url of sources) if (!this.sources.has(url)) this.sources.set(url, followStats(url, this.counters));
    if (this.sources.size > 0) this.start();
    else this.stop();
  }

  /** Stop following every source, and drop what was not submitted. */
  close(): void {
    this.set([], []);
    this.reporter.clear();
  }

  private start(): void {
    if (this.timer !== undefined) return;
    this.intervalStartedAt = Date.now();
    this.timer = setInterval(() => this.sample(), SAMPLE_MS);
  }

  private stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.previous = undefined;
    this.interval = new Map();
  }

  /** Sample each exposure's rates since the last sample, then report if the interval has ended. */
  private sample(): void {
    const now = Date.now();
    const snapshot = copyCounters(this.counters);
    const previous = this.previous;
    if (previous !== undefined) {
      const seconds = (now - this.previousAt) / 1000;
      for (const path of this.paths) this.addSamples(path, snapshot, previous, seconds);
    }
    this.previous = snapshot;
    this.previousAt = now;
    if (now - this.intervalStartedAt + SAMPLE_MS / 2 >= REPORT_MS) void this.report(now);
  }

  /** Add an exposure's rates to its interval, each only when some node had its stats at both samples. */
  private addSamples(path: ExposurePath, snapshot: Counters, previous: Counters, seconds: number): void {
    const samples = this.interval.get(path.exposureId) ?? { received: [], sent: [], viewers: [] };
    this.interval.set(path.exposureId, samples);
    const received = rate(snapshot, previous, 'received', path, seconds);
    const sent = rate(snapshot, previous, 'sent', path, seconds);
    if (received !== undefined) samples.received.push(received);
    if (sent !== undefined) samples.sent.push(sent);
    if (sent !== undefined) samples.viewers.push(viewers(snapshot, path));
  }

  /** Submit each exposure's summary of the interval, and start the next. */
  private async report(now: number): Promise<void> {
    const exposures = this.interval;
    this.interval = new Map();
    this.intervalStartedAt = now;
    const observedAt = new Date(now).toISOString();
    for (const [exposureId, samples] of exposures) {
      const metrics = metricsOf(samples);
      if (metrics.length > 0) this.reporter.queue(observedAt, metrics, `exposure:${exposureId}`);
    }
    if (this.reporting || this.reporter.queued === 0) return;
    this.reporting = true;
    try {
      await this.reporter.submit();
    } catch (error) {
      logger.warn('Submitting the relays’ traffic failed: {error}', { error });
    } finally {
      this.reporting = false;
    }
  }
}

/** The path a URL is dialed at, without its leading slash: where a publisher's broadcasts are on the relay. */
function pathOf(url: string): string {
  return new URL(url).pathname.replace(/^\/+/, '').replace(/\/+$/, '');
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

/** An exposure's summaries of an interval, for whichever it has samples of. */
function metricsOf(samples: ExposureSamples): Metric[] {
  const metrics: Metric[] = [];
  if (samples.received.length > 0) metrics.push(summary(relayMetrics.ingestBitrate, samples.received));
  if (samples.sent.length > 0) metrics.push(summary(relayMetrics.egressBitrate, samples.sent));
  if (samples.viewers.length > 0) metrics.push(summary(relayMetrics.viewers, samples.viewers));
  return metrics;
}

/**
 * Follow the stats at `url` into `counters`: every node's broadcast announced beneath it, until stopped. A node's
 * counters are kept by the relay it is on and its path, so a renewed token's connection continues them.
 */
function followStats(url: string, counters: Counters): () => void {
  const effect = new Moq.Signals.Effect();
  const consumed = new Moq.Origin.Producer();
  const connection = new Moq.Connection({ url: new URL(url), consume: consumed });
  const relay = new URL(url).host;
  effect.cleanup(() => {
    connection.close();
    consumed.close();
  });
  effect.spawn(async () => {
    // Follow each node's broadcast while it is announced, stopping every one when this source is stopped.
    const announced = consumed.announced();
    effect.cleanup(() => announced.close());
    const followed = new Map<string, () => void>();
    effect.cleanup(() => {
      for (const stop of followed.values()) stop();
    });
    for (let update = await effect.race(announced.next()); update; update = await effect.race(announced.next())) {
      // Each node's broadcast, followed while it is announced; anything else beneath the path is not stats.
      if (!/^node(\/|$)/.test(update.prefix)) continue;
      const node = `${relay}/${update.prefix}`;
      followed.get(node)?.();
      followed.delete(node);
      if (update.kind !== 'retracted') followed.set(node, followNode(consumed, update.prefix, node, counters));
    }
  });
  return () => effect.close();
}

/** Follow one node's broadcast: each role's track into `counters`, for as long as the broadcast is there. */
function followNode(consumed: Moq.Origin.Producer, path: Moq.Path.Valid, node: string, counters: Counters): () => void {
  const effect = new Moq.Signals.Effect();
  const request = consumed.request(path, { announced: true });
  effect.cleanup(() => request.close());
  effect.run(following => {
    const active = following.get(request.active);
    if (active === undefined) return;
    for (const role of ROLES) following.spawn(() => followRole(following, active, role, node, counters));
  });
  return () => effect.close();
}

/** Follow one track of a node's stats, subscribing again after a subscription fails or ends, until torn down. */
async function followRole(
  following: Moq.Signals.Effect,
  broadcast: Moq.Broadcast.Consumer,
  role: Role,
  node: string,
  counters: Counters
): Promise<void> {
  for (;;) {
    await readTraffic(following, broadcast, role, traffic => {
      const roles = counters.get(node) ?? new Map<Role, Traffic>();
      roles.set(role, traffic);
      counters.set(node, roles);
    });
    const waited = await following.race(new Promise<true>(resolve => setTimeout(() => resolve(true), RESUBSCRIBE_MS)));
    if (waited === undefined) return;
  }
}

/** Reads one subscription to a node's traffic track: each group is a frame of the counters, newest last. */
async function readTraffic(
  following: Moq.Signals.Effect,
  broadcast: Moq.Broadcast.Consumer,
  role: Role,
  onTraffic: (traffic: Traffic) => void
): Promise<void> {
  const track = broadcast.track(ROLE_TRACKS[role]).subscribe({ priority: 0 });
  try {
    for (let group = await following.race(track.recvGroup()); group; group = await following.race(track.recvGroup())) {
      const traffic = TrafficSchema.safeParse(await following.race(group.readJson()));
      if (traffic.success) onTraffic(traffic.data);
    }
  } catch (error) {
    logger.debug('A relay stats subscription ended: {error}', { error });
  } finally {
    track.close();
  }
}
