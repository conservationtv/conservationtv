import { getLogger } from '@logtape/logtape';
import * as Moq from '@moq/net';
import { z } from 'zod';

const logger = getLogger(['agent', 'relay-traffic']);

// Following the relays' traffic stats over MoQ: each relay node publishes its counters as a broadcast, `node/<node>`,
// beneath the stats path, with a track per role. Every node's are followed into one set of counters, kept by the relay
// and node they are from, which the runtime samples (runtime.ts). Nothing here knows about exposures or rates.

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
export type TrafficEntry = z.output<typeof TrafficEntrySchema>;
const TrafficSchema = z.record(z.string(), TrafficEntrySchema);
export type Traffic = z.output<typeof TrafficSchema>;

/** Which way traffic went, by the track a node publishes it on: what it received, and what it sent. */
const ROLE_TRACKS = { received: 'consumer/subscriber.json', sent: 'consumer/publisher.json' } as const;
export type Role = keyof typeof ROLE_TRACKS;
const ROLES: Role[] = ['received', 'sent'];

/** Each node's latest counters, by the relay and node they are from, and by role. */
export type Counters = Map<string, Map<Role, Traffic>>;

/**
 * Follow the stats at `url` into `counters`: every node's broadcast announced beneath it, until stopped. A node's
 * counters are kept by the relay it is on and its path, so two sources following one node write the same counters; a
 * node no longer followed, retracted or with its source stopped, leaves them.
 */
export function followStats(url: string, counters: Counters): () => void {
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

/**
 * Follow one node's broadcast: each role's track into `counters`, for as long as the broadcast is there. Stopped, it
 * takes the node's counters with it, unless another follower of the node (a renewed token's) has written them since.
 */
function followNode(consumed: Moq.Origin.Producer, path: Moq.Path.Valid, node: string, counters: Counters): () => void {
  const effect = new Moq.Signals.Effect();
  const request = consumed.request(path, { announced: true });
  const roles = new Map<Role, Traffic>();
  effect.cleanup(() => {
    request.close();
    if (counters.get(node) === roles) counters.delete(node);
  });
  effect.run(following => {
    const active = following.get(request.active);
    if (active === undefined) return;
    for (const role of ROLES) following.spawn(() => followRole(following, active, role, node, roles, counters));
  });
  return () => effect.close();
}

/** Follow one track of a node's stats, subscribing again after a subscription fails or ends, until torn down. */
async function followRole(
  following: Moq.Signals.Effect,
  broadcast: Moq.Broadcast.Consumer,
  role: Role,
  node: string,
  roles: Map<Role, Traffic>,
  counters: Counters
): Promise<void> {
  for (;;) {
    await readTraffic(following, broadcast, role, traffic => {
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
