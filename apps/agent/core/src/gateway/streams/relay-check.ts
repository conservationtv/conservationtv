import { exposureSubject, relayMetrics } from '@conservationtv/reports';
import { getLogger } from '@logtape/logtape';
import * as Moq from '@moq/net';
import { type Journal, useJournal } from '../../reporting/journal.ts';
import { type IntervalSamples, REPORT_INTERVAL_MS, Sampler } from '../../reporting/sampler.ts';

const logger = getLogger(['agent', 'mediamtx', 'relay-check']);

// Whether the relay has each exposure the agent publishes, or covers without publishing it, to give. The moq CLI
// publishes an exposure as the one broadcast its readers watch, `{exposure path}/live.hang` (config.ts), whose catalog
// is the CLI's own: what it carries, each picture by its size; a browser publishing straight to the relay publishes
// the same broadcast. The agent reads that catalog back through the relay, on a connection of its own: while the
// broadcast is announced there and its catalog comes back, the relay has the exposure to give. That is reported about
// the exposure (`relay.announced`), and the exposure appearing on the relay or going from it is an event about it
// (`broadcast.announced`, `broadcast.withdrawn`). It is the one thing about the relay that doesn't depend on anyone
// watching: a relay asks a publisher only for what viewers take, and the catalog alone pulls no media.
//
// A check is of an exposure's broadcast, whatever it is read with. A renewed token is a new connection beside the old,
// which is closed once the new one has the broadcast, or the old one has lost it (as when its token runs out): until
// then the relay has the exposure if either says so, so a renewal is never taken for the broadcast going.

/** The track every hang broadcast describes itself on. */
const CATALOG_TRACK = 'catalog.json';

/** How long to wait before subscribing to the catalog again, after a subscription failed or ended. */
const RESUBSCRIBE_MS = 1_000;

/**
 * A broadcast to check on the relay: the exposure it is of, the URL to dial, carrying a token as `?jwt=` (a publisher's
 * own, or a read token for one the agent watches), and the broadcast under it.
 */
export interface CheckedBroadcast {
  exposureId: string;
  connect: string;
  broadcast: string;
}

/** Whether the relay has the broadcast to give: announced there, and a catalog read back since it was. */
interface Announced {
  there: boolean;
}

/**
 * Follows the broadcast's catalog through the relay until the effect closes, keeping `announced` as it comes and goes.
 * A subscription that fails or ends, as when the publisher restarts, is made again after `RESUBSCRIBE_MS`.
 */
function followCatalog(
  effect: Moq.Signals.Effect,
  consumed: Moq.Origin.Producer,
  broadcast: string,
  announced: Announced
): void {
  const request = consumed.request(Moq.Path.from(broadcast), { announced: true });
  effect.cleanup(() => request.close());
  effect.cleanup(() => {
    announced.there = false;
  });
  effect.run(following => {
    // Each announcement of the broadcast is read anew: the relay has it once a catalog has come back from this one.
    announced.there = false;
    const active = following.get(request.active);
    if (active === undefined) return;
    following.spawn(async () => {
      for (;;) {
        await readCatalogs(following, active, () => {
          announced.there = true;
        });
        // Torn down while waiting (the check closed, or the broadcast went): stop; otherwise subscribe again.
        const waited = await following.race(
          new Promise<true>(resolve => setTimeout(() => resolve(true), RESUBSCRIBE_MS))
        );
        if (waited === undefined) return;
      }
    });
  });
}

/** Reads one subscription to a broadcast's catalog, calling `read` for each group, a version, until it fails or ends. */
async function readCatalogs(
  following: Moq.Signals.Effect,
  broadcast: Moq.Broadcast.Consumer,
  read: () => void
): Promise<void> {
  const track = broadcast.track(CATALOG_TRACK).subscribe({ priority: 0 });
  try {
    for (let group = await following.race(track.recvGroup()); group; group = await following.race(track.recvGroup())) {
      read();
    }
  } catch (error) {
    logger.debug('A catalog subscription ended: {error}', { error });
  } finally {
    track.close();
  }
}

/**
 * Checks one exposure's broadcast on the relay, on a connection of its own, reconnecting if it drops, until the
 * returned function closes it.
 */
function checkBroadcast(publisher: CheckedBroadcast, announced: Announced): () => void {
  const effect = new Moq.Signals.Effect();
  const consumed = new Moq.Origin.Producer();
  const url = new URL(publisher.connect);
  const connection = new Moq.Connection({ url, consume: consumed });
  effect.cleanup(() => {
    connection.close();
    consumed.close();
  });
  effect.run(watching => {
    const error = watching.get(connection.error);
    if (error === undefined) return;
    logger.error('Checking {exposureId} on the relay failed: {error}', { exposureId: publisher.exposureId, error });
  });
  followCatalog(effect, consumed, publisher.broadcast, announced);
  return () => effect.close();
}

/** One connection checking a broadcast: whether the relay has it, as read there, and how to close it. */
interface Reading {
  announced: Announced;
  close(): void;
}

/**
 * A checked broadcast: the exposure it is of, the URL it is read at now, as `connect`, and the connection reading it
 * there; and the one it replaced, while that is kept.
 */
interface Checked {
  exposureId: string;
  connect: string;
  current: Reading;
  previous: Reading | undefined;
}

/** What tells one check from another: the exposure and its broadcast, not the token it is read with. */
function checkKey({ exposureId, broadcast }: CheckedBroadcast): string {
  return JSON.stringify([exposureId, broadcast]);
}

function reading(publisher: CheckedBroadcast): Reading {
  const announced: Announced = { there: false };
  return { announced, close: checkBroadcast(publisher, announced) };
}

/** Whether the relay has the broadcast, by either connection; the replaced one closed once it no longer matters. */
function settle(check: Checked): boolean {
  const { current, previous } = check;
  if (previous !== undefined && (current.announced.there || !previous.announced.there)) {
    previous.close();
    check.previous = undefined;
  }
  return current.announced.there || (check.previous?.announced.there ?? false);
}

function closeChecked(check: Checked): void {
  check.current.close();
  check.previous?.close();
}

/** How often each exposure is sampled for whether the relay has it; summarised every `REPORT_INTERVAL_MS`. */
const SAMPLE_MS = 5_000;

/**
 * Whether the relay has each exposure it is given, each checked while it is given, reported while there are any: those
 * MediaMTX publishes (streams/runtime.ts), and those the agent watches (relay-traffic/runtime.ts).
 */
export class RelayCheck {
  /** Each check, by its exposure and broadcast (`checkKey`). */
  private readonly checked = new Map<string, Checked>();
  private readonly sampler: Sampler<object>;
  private readonly journal: Journal;
  /** The exposures the relay had at the last sample: what a change is told from. */
  private had = new Set<string>();

  constructor() {
    this.journal = useJournal();
    this.sampler = new Sampler<object>({
      stopped: {},
      sample: samples => this.sample(samples),
      target: exposureId => ({ subjectId: exposureSubject(exposureId), dimensions: {} })
    });
  }

  /**
   * Checks each broadcast, and no other. One read at a new URL, as with a renewed token, is read there beside the old
   * until it is clear what the new one says.
   */
  set(publishers: CheckedBroadcast[]): void {
    const wanted = new Map(publishers.map(publisher => [checkKey(publisher), publisher]));
    for (const [key, check] of this.checked) {
      if (wanted.has(key)) continue;
      closeChecked(check);
      this.checked.delete(key);
    }
    for (const [key, publisher] of wanted) {
      const check = this.checked.get(key);
      if (check === undefined) {
        const { exposureId, connect } = publisher;
        this.checked.set(key, { exposureId, connect, current: reading(publisher), previous: undefined });
        continue;
      }
      if (check.connect === publisher.connect) continue;
      check.previous?.close();
      check.previous = check.current;
      check.current = reading(publisher);
      check.connect = publisher.connect;
    }
    this.report();
  }

  close(): void {
    this.set([]);
  }

  /** Stop the timer for good when the agent stops, and close every check. */
  dispose(): void {
    this.close();
    this.sampler.dispose();
  }

  /** Sample while there is anything checked, and not otherwise. */
  private report(): void {
    const checking = this.checked.size > 0;
    if (checking && !this.sampler.running) this.sampler.start({ sampleMs: SAMPLE_MS, reportMs: REPORT_INTERVAL_MS });
    if (!checking && this.sampler.running) this.sampler.stop();
    if (!checking) this.had = new Set();
  }

  /** Sample whether the relay has each exposure, and say which came onto it or went since the last sample. */
  private sample(samples: IntervalSamples): void {
    const has = new Set<string>();
    for (const check of this.checked.values()) {
      // Each exposure's sample, kept in `has` when the relay has it, and an event when that has changed.
      const { exposureId } = check;
      const there = settle(check);
      samples.add(exposureId, relayMetrics.announced, there ? 1 : 0);
      if (there) has.add(exposureId);
      if (there === this.had.has(exposureId)) continue;
      const type = there ? 'broadcast.announced' : 'broadcast.withdrawn';
      this.journal.event(type, {}, exposureSubject(exposureId));
    }
    this.had = has;
  }
}
