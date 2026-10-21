import * as Moq from '@moq/net';
import { z } from 'zod';
import type { MoqPublisher } from './config.ts';

// Each rendition of a published exposure is a broadcast of its own under the exposure's path, which the moq CLI
// publishes (config.ts): `{organisation}/{exposure}/{rendition}`. Readers watch one broadcast, `{exposure path}/live.hang`,
// so the agent publishes that too, with nothing in it but a catalog joining the renditions': each of its tracks is
// listed where it already is, by its rendition's broadcast (`broadcast`, relative to the joined broadcast) and its name
// there (`track`), so no media passes through the agent. Every rendition broadcast names its tracks alike, so they are
// listed under the rendition's name instead, and the audio, the same in every rendition, only once.
//
// The joined catalog follows the renditions': it is rewritten whenever one of theirs changes, and keeps a rendition's
// last catalog while its publisher restarts.

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

/** The joined catalog's entry for a track of a rendition broadcast: its config, and where to find it. */
function reference(rendition: string, track: string, config: TrackConfig) {
  return { ...config, broadcast: `./${rendition}`, track };
}

/** Each rendition's video, by the rendition's name, and the track's too should it have several. */
function joinedVideo(catalogs: RenditionCatalog[]): Tracks {
  const renditions: Tracks['renditions'] = {};
  for (const { rendition, catalog } of catalogs) {
    // Every track of every rendition, keyed so no two collide though their names do.
    const tracks = Object.entries(catalog.video?.renditions ?? {});
    for (const [track, config] of tracks) {
      renditions[tracks.length === 1 ? rendition : `${rendition}.${track}`] = reference(rendition, track, config);
    }
  }
  return { renditions };
}

/** The audio of the first rendition that has any, which is every rendition's. */
function joinedAudio(catalogs: RenditionCatalog[]): Tracks | undefined {
  for (const { rendition, catalog } of catalogs) {
    const [first] = Object.entries(catalog.audio?.renditions ?? {});
    if (first !== undefined) return { renditions: { audio: reference(rendition, first[0], first[1]) } };
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

/** Whether two publishers join the same renditions into the same broadcast, whatever their credentials. */
function sameJoin(a: MoqPublisher, b: MoqPublisher) {
  return a.broadcast === b.broadcast && JSON.stringify(a.renditions) === JSON.stringify(b.renditions);
}

/** One exposure's joined broadcast, on a connection of its own to the relay, reconnecting if it drops. */
class JoinedBroadcast {
  private readonly published = new Moq.Origin.Producer();
  private readonly consumed = new Moq.Origin.Producer();
  private readonly connection: Moq.Connection;
  private readonly effect = new Moq.Signals.Effect();
  private readonly catalogs = new Map<string, Catalog>();
  private readonly catalogTrack: Moq.Track.Producer;
  private written = '';

  constructor(public publisher: MoqPublisher) {
    const url = new URL(publisher.connect);
    this.connection = new Moq.Connection({ url, publish: this.published.consume(), consume: this.consumed });
    const broadcast = this.published.createBroadcast(Moq.Path.from(publisher.broadcast));
    broadcast.announce();
    this.catalogTrack = broadcast.createTrack(CATALOG_TRACK);
    this.effect.cleanup(() => broadcast.close());
    this.effect.run(effect => {
      const error = effect.get(this.connection.error);
      if (error === undefined) return;
      const event = { event: 'moq_join_failed', exposureId: publisher.exposureId, error: String(error) };
      console.error(JSON.stringify(event));
    });
    for (const { rendition } of publisher.renditions) this.follow(rendition);
  }

  /** Reconnects with the publisher's new credentials. */
  renew(publisher: MoqPublisher) {
    if (publisher.connect !== this.publisher.connect) this.connection.url.set(new URL(publisher.connect));
    this.publisher = publisher;
  }

  close() {
    this.effect.close();
    this.connection.close();
    this.published.close();
    this.consumed.close();
  }

  /** Reads the rendition broadcast's catalog whenever it is published, across its publisher's restarts. */
  private follow(rendition: string) {
    const request = this.consumed.request(Moq.Path.from(rendition), { announced: true });
    this.effect.cleanup(() => request.close());
    this.effect.run(effect => {
      const active = effect.get(request.active);
      if (active === undefined) return;
      const track = active.track(CATALOG_TRACK).subscribe({ priority: 0 });
      effect.cleanup(() => track.close());
      effect.spawn(async () => {
        // Each group is one version of the catalog.
        for (let group = await effect.race(track.recvGroup()); group; group = await effect.race(track.recvGroup())) {
          const catalog = CatalogSchema.safeParse(await effect.race(group.readJson()));
          if (catalog.success) this.update(rendition, catalog.data);
        }
      });
    });
  }

  /** Publishes the joined catalog as a new group, if the rendition's catalog changed it. */
  private update(rendition: string, catalog: Catalog) {
    this.catalogs.set(rendition, catalog);
    const catalogs = this.publisher.renditions.flatMap(({ rendition: name }) => {
      const known = this.catalogs.get(name);
      return known === undefined ? [] : [{ rendition: name, catalog: known }];
    });
    const text = JSON.stringify(joinCatalogs(catalogs));
    if (text === this.written) return;
    this.written = text;
    const group = this.catalogTrack.appendGroup();
    group.writeString(text);
    group.close();
  }
}

/** The joined broadcast of each exposure the spec publishes, and no other. */
export class BroadcastJoiner {
  private readonly joined = new Map<string, JoinedBroadcast>();

  /** Joins what the publishers name: new ones are started, gone or changed ones closed, renewed ones reconnected. */
  apply(publishers: MoqPublisher[]) {
    const wanted = new Map(publishers.map(publisher => [publisher.exposureId, publisher]));
    for (const [exposureId, joined] of this.joined) {
      const publisher = wanted.get(exposureId);
      if (publisher !== undefined && sameJoin(joined.publisher, publisher)) continue;
      joined.close();
      this.joined.delete(exposureId);
    }
    for (const publisher of publishers) {
      const joined = this.joined.get(publisher.exposureId);
      if (joined === undefined) this.joined.set(publisher.exposureId, new JoinedBroadcast(publisher));
      else joined.renew(publisher);
    }
  }

  close() {
    for (const joined of this.joined.values()) joined.close();
    this.joined.clear();
  }
}
