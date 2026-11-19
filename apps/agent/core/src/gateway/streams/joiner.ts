import { exposureSubject, relayMetrics } from '@conservationtv/reports';
import { getLogger } from '@logtape/logtape';
import * as Moq from '@moq/net';
import { z } from 'zod';
import { type Journal, useJournal } from '../../reporting/journal.ts';
import { type IntervalSamples, REPORT_INTERVAL_MS, Sampler } from '../../reporting/sampler.ts';
import type { MoqPublisher } from './config.ts';

const logger = getLogger(['agent', 'mediamtx', 'joiner']);

// Each rendition of a published exposure is a broadcast of its own under the exposure's path, which the moq CLI
// publishes (config.ts): `{organisation}/{exposure}/{rendition}`. Readers watch one broadcast, `{exposure path}/live.hang`,
// so the agent publishes that too, with nothing in it but a catalog joining the renditions': each of its tracks is
// listed where it already is, by its rendition's broadcast (`broadcast`, relative to the joined broadcast), so no media
// passes through the agent, and the audio, the same in every rendition, only once.
//
// A hang catalog keys each rendition by the name of the track to subscribe to, and has no other field for it: a reader
// subscribes to that key in the rendition's `broadcast`. So the joined catalog keys every track by its own name. The moq
// CLI names every rendition broadcast's tracks alike (`0.flv-v`), so of renditions whose tracks share a name only the
// first, in the publisher's order, is listed: an exposure's other renditions are not reachable through the joined
// broadcast until their tracks are named apart.
//
// The joined catalog follows the renditions': it is rewritten whenever one of theirs changes, and keeps a rendition's
// last catalog while its publisher restarts.
//
// Reading each rendition's catalog back through the relay also says whether the relay has the rendition to give: its
// broadcast is announced there, and its catalog came back. That is reported about the exposure, per rendition
// (`relay.announced`), and a rendition appearing on the relay or going from it is an event about it
// (`rendition.announced`, `rendition.withdrawn`). It is the one thing about the relay that doesn't depend on anyone
// watching: a relay asks a publisher only for what viewers take.

/** The track every hang broadcast describes itself on. */
const CATALOG_TRACK = 'catalog.json';

/** A catalog section: each track's decoder config, by its name. Only the configs' references are read. */
const TrackConfigSchema = z.record(z.string(), z.unknown());
type TrackConfig = z.output<typeof TrackConfigSchema>;
const TracksSchema = z.object({ renditions: z.record(z.string(), TrackConfigSchema) });
type Tracks = z.output<typeof TracksSchema>;

/** The sections of a rendition broadcast's catalog that the joined catalog lists. */
const CatalogSchema = z.object({ video: TracksSchema.optional(), audio: TracksSchema.optional() });
type Catalog = z.output<typeof CatalogSchema>;

/** A rendition broadcast's latest catalog. */
interface RenditionCatalog {
  rendition: string;
  catalog: Catalog;
}

/** The joined catalog's entry for a track of a rendition broadcast: its config, and the broadcast to find it in. */
function reference(rendition: string, config: TrackConfig) {
  return { ...config, broadcast: `./${rendition}` };
}

/** Every rendition's video tracks, each by its own name; of tracks sharing a name, the first rendition's. */
function joinedVideo(catalogs: RenditionCatalog[]): Tracks {
  const renditions: Tracks['renditions'] = {};
  for (const { rendition, catalog } of catalogs) {
    // Each of the rendition's video tracks, unless an earlier rendition already listed one by that name.
    for (const [track, config] of Object.entries(catalog.video?.renditions ?? {})) {
      if (Object.hasOwn(renditions, track)) continue;
      renditions[track] = reference(rendition, config);
    }
  }
  return { renditions };
}

/** The audio of the first rendition that has any, which is every rendition's, by its track's own name. */
function joinedAudio(catalogs: RenditionCatalog[]): Tracks | undefined {
  for (const { rendition, catalog } of catalogs) {
    const [first] = Object.entries(catalog.audio?.renditions ?? {});
    if (first !== undefined) return { renditions: { [first[0]]: reference(rendition, first[1]) } };
  }
  return undefined;
}

/** The joined catalog of the renditions' latest. */
export function joinCatalogs(catalogs: RenditionCatalog[]): Catalog {
  const joined: Catalog = { video: joinedVideo(catalogs) };
  const audio = joinedAudio(catalogs);
  if (audio !== undefined) joined.audio = audio;
  return joined;
}

/** How long to wait before subscribing to a rendition's catalog again, after a subscription failed or ended. */
const RESUBSCRIBE_MS = 1_000;

/** Whether the relay has each of an exposure's renditions to give, by rendition: what reading them back finds. */
type Announced = Map<string, boolean>;

/**
 * A rendition broadcast's catalog, as it is published: undefined until it first is, then its latest. A subscription
 * that fails or ends, as when the rendition's publisher restarts, is made again after `RESUBSCRIBE_MS`, keeping the
 * last catalog meanwhile, until the join closes. `announced` says whether the broadcast is on the relay now, and has
 * given a catalog since it was.
 */
function followCatalog(
  effect: Moq.Signals.Effect,
  consumed: Moq.Origin.Producer,
  rendition: string,
  announced: Announced
): Moq.Signals.Getter<Catalog | undefined> {
  const latest = new Moq.Signals.Signal<Catalog | undefined>(undefined);
  const request = consumed.request(Moq.Path.from(rendition), { announced: true });
  effect.cleanup(() => request.close());
  effect.cleanup(() => announced.set(rendition, false));
  effect.run(following => {
    // Each announcement of the broadcast is read anew: the relay has it once a catalog has come back from this one.
    announced.set(rendition, false);
    const active = following.get(request.active);
    if (active === undefined) return;
    following.spawn(async () => {
      for (;;) {
        await readCatalogs(following, active, catalog => {
          latest.set(catalog);
          announced.set(rendition, true);
        });
        // Torn down while waiting (the join closed, or the broadcast went): stop; otherwise subscribe again.
        const waited = await following.race(
          new Promise<true>(resolve => setTimeout(() => resolve(true), RESUBSCRIBE_MS))
        );
        if (waited === undefined) return;
      }
    });
  });
  return latest;
}

/** Reads one subscription to a broadcast's catalog, giving `read` each group, a version, until it fails or ends. */
async function readCatalogs(
  following: Moq.Signals.Effect,
  broadcast: Moq.Broadcast.Consumer,
  read: (catalog: Catalog) => void
): Promise<void> {
  const track = broadcast.track(CATALOG_TRACK).subscribe({ priority: 0 });
  try {
    for (let group = await following.race(track.recvGroup()); group; group = await following.race(track.recvGroup())) {
      const catalog = CatalogSchema.safeParse(await following.race(group.readJson()));
      if (catalog.success) read(catalog.data);
    }
  } catch (error) {
    logger.debug('A rendition catalog subscription ended: {error}', { error });
  } finally {
    track.close();
  }
}

/**
 * How often the joined catalog is written again unchanged. A group stops being served a few seconds after it is
 * written (seen on moq-relay 0.17: a catalog written once reaches subscribers for about three seconds, then never), so a
 * viewer arriving later only gets a catalog if a recent one exists.
 */
const CATALOG_REFRESH_MS = 2_000;

/**
 * Writes the catalog `track` describes its broadcast by: a new group whenever `catalog` reads differently, and the
 * latest again every `CATALOG_REFRESH_MS`, so one is always fresh enough to reach a new viewer.
 */
function writeCatalog(
  effect: Moq.Signals.Effect,
  track: Moq.Track.Producer,
  catalog: (watching: Moq.Signals.Effect) => Catalog
): void {
  let written = '';
  const write = (text: string) => {
    const group = track.appendGroup();
    group.writeString(text);
    group.close();
  };
  effect.run(watching => {
    const text = JSON.stringify(catalog(watching));
    if (text === written) return;
    written = text;
    write(text);
  });
  const refresh = setInterval(() => write(written), CATALOG_REFRESH_MS);
  effect.cleanup(() => clearInterval(refresh));
}

/**
 * Joins one exposure's renditions into its broadcast, on a connection of its own to the relay, reconnecting if it
 * drops, until the returned function closes it. New credentials are a new join, as they restart the renditions'
 * publishers too. `announced` is kept as each rendition comes onto the relay, or goes from it.
 */
function joinBroadcast(publisher: MoqPublisher, announced: Announced): () => void {
  const effect = new Moq.Signals.Effect();
  const published = new Moq.Origin.Producer();
  const consumed = new Moq.Origin.Producer();
  const url = new URL(publisher.connect);
  const connection = new Moq.Connection({ url, publish: published.consume(), consume: consumed });
  const broadcast = published.createBroadcast(Moq.Path.from(publisher.broadcast));
  broadcast.announce();
  effect.cleanup(() => {
    broadcast.close();
    connection.close();
    published.close();
    consumed.close();
  });
  effect.run(watching => {
    const error = watching.get(connection.error);
    if (error === undefined) return;
    logger.error('Joining {exposureId} failed: {error}', { exposureId: publisher.exposureId, error });
  });

  // In the publisher's order, so the joined catalog lists the renditions as it does.
  const followed = publisher.renditions.map(({ rendition }) => ({
    rendition,
    catalog: followCatalog(effect, consumed, rendition, announced)
  }));
  writeCatalog(effect, broadcast.createTrack(CATALOG_TRACK), watching =>
    joinCatalogs(
      followed.flatMap(({ rendition, catalog }) => {
        const latest = watching.get(catalog);
        return latest === undefined ? [] : [{ rendition, catalog: latest }];
      })
    )
  );
  return () => effect.close();
}

/** A joined broadcast: how to close it, the exposure it is of, and whether the relay has each of its renditions. */
interface Joined {
  exposureId: string;
  announced: Announced;
  close(): void;
}

/** How often each rendition is sampled for whether the relay has it; summarised every `REPORT_INTERVAL_MS`. */
const SAMPLE_MS = 5_000;

/** What tells one rendition's series from another's: its exposure, then its rendition. */
function seriesKey(exposureId: string, rendition: string): string {
  return `${exposureId}/${rendition}`;
}

/**
 * The joined broadcasts of the exposures MediaMTX publishes, each joined while its publisher is wanted, and whether the
 * relay has each of their renditions, reported while there are any.
 */
export class BroadcastJoiner {
  /** Each joined broadcast, by the publisher it joins for, as JSON. */
  private readonly joined = new Map<string, Joined>();
  private readonly sampler: Sampler<object>;
  private readonly journal: Journal;
  /** The renditions the relay had at the last sample, by series key: what a change is told from. */
  private had = new Set<string>();

  constructor() {
    this.journal = useJournal();
    this.sampler = new Sampler<object>({
      stopped: {},
      sample: samples => this.sample(samples),
      target: key => {
        const [exposureId = '', rendition = ''] = key.split('/');
        return { subjectId: exposureSubject(exposureId), dimensions: { rendition } };
      }
    });
  }

  /** Joins the broadcast of each publisher, and no other: a publisher that changed at all is joined anew. */
  set(publishers: MoqPublisher[]): void {
    const wanted = new Map(publishers.map(publisher => [JSON.stringify(publisher), publisher]));
    for (const [key, join] of this.joined) {
      if (wanted.has(key)) continue;
      join.close();
      this.joined.delete(key);
    }
    for (const [key, publisher] of wanted) {
      if (this.joined.has(key)) continue;
      const announced: Announced = new Map(publisher.renditions.map(({ rendition }) => [rendition, false]));
      const close = joinBroadcast(publisher, announced);
      this.joined.set(key, { exposureId: publisher.exposureId, announced, close });
    }
    this.report();
  }

  close(): void {
    this.set([]);
  }

  /** Stop the timer for good when the agent stops, and close every join. */
  dispose(): void {
    this.close();
    this.sampler.dispose();
  }

  /** Sample while there is anything joined, and not otherwise. */
  private report(): void {
    const joining = this.joined.size > 0;
    if (joining && !this.sampler.running) this.sampler.start({ sampleMs: SAMPLE_MS, reportMs: REPORT_INTERVAL_MS });
    if (!joining && this.sampler.running) this.sampler.stop();
    if (!joining) this.had = new Set();
  }

  /** Sample whether the relay has each rendition, and say which came onto it or went since the last sample. */
  private sample(samples: IntervalSamples): void {
    const has = new Set<string>();
    for (const { exposureId, announced } of this.joined.values())
      for (const [rendition, there] of announced) this.sampleRendition(samples, has, { exposureId, rendition, there });
    this.had = has;
  }

  /** One rendition's sample, kept in `has` when the relay has it, and an event when that has changed. */
  private sampleRendition(samples: IntervalSamples, has: Set<string>, sampled: SampledRendition): void {
    const { exposureId, rendition, there } = sampled;
    const key = seriesKey(exposureId, rendition);
    samples.add(key, relayMetrics.announced, there ? 1 : 0);
    if (there) has.add(key);
    if (there === this.had.has(key)) return;
    const type = there ? 'rendition.announced' : 'rendition.withdrawn';
    this.journal.event(type, { rendition }, exposureSubject(exposureId));
  }
}

/** A rendition as it was sampled: whether the relay has it. */
interface SampledRendition {
  exposureId: string;
  rendition: string;
  there: boolean;
}
