import { getLogger } from '@logtape/logtape';
import * as Moq from '@moq/net';
import { z } from 'zod';
import type { MoqPublisher } from './config.ts';

const logger = getLogger(['agent', 'mediamtx', 'joiner']);

// Each rendition of a published exposure is a broadcast of its own under the exposure's path, which the moq CLI
// publishes (config.ts): `{organisation}/{exposure}/{rendition}`. Readers watch one broadcast, `{exposure path}/live.hang`,
// so the agent publishes that too, with nothing in it but a catalog joining the renditions': each of its tracks is
// listed where it already is, under its name there and by its rendition's broadcast (`broadcast`, relative to the
// joined broadcast), so no media passes through the agent. hang keys a rendition by its track's name, and has no other
// field for it, while every rendition broadcast names its tracks alike: until they are told apart, only the first
// rendition's video is listed, and the audio, the same in every rendition, only once.
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

/** The joined catalog's entry for a track of a rendition broadcast: its config, and the broadcast to find it in. */
function reference(rendition: string, config: TrackConfig) {
  return { ...config, broadcast: `./${rendition}` };
}

/** The renditions' video, by each track's name: the first rendition's, of any that name their tracks alike. */
function joinedVideo(catalogs: RenditionCatalog[]): Tracks {
  const renditions: Tracks['renditions'] = {};
  for (const { rendition, catalog } of catalogs) {
    // Every track of every rendition, in the publisher's order, skipping a name an earlier rendition already took.
    for (const [track, config] of Object.entries(catalog.video?.renditions ?? {})) {
      if (track in renditions) continue;
      renditions[track] = reference(rendition, config);
    }
  }
  return { renditions };
}

/** The audio of the first rendition that has any, which is every rendition's. */
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

/** A rendition broadcast's catalog, as it is published: undefined until it first is, then its latest. */
function followCatalog(
  effect: Moq.Signals.Effect,
  consumed: Moq.Origin.Producer,
  rendition: string
): Moq.Signals.Getter<Catalog | undefined> {
  const latest = new Moq.Signals.Signal<Catalog | undefined>(undefined);
  const request = consumed.request(Moq.Path.from(rendition), { announced: true });
  effect.cleanup(() => request.close());
  effect.run(following => {
    const active = following.get(request.active);
    if (active === undefined) return;
    const track = active.track(CATALOG_TRACK).subscribe({ priority: 0 });
    following.cleanup(() => track.close());
    following.spawn(async () => {
      // Each group is one version of the catalog.
      for (
        let group = await following.race(track.recvGroup());
        group;
        group = await following.race(track.recvGroup())
      ) {
        const catalog = CatalogSchema.safeParse(await following.race(group.readJson()));
        if (catalog.success) latest.set(catalog.data);
      }
    });
  });
  return latest;
}

/** Writes the catalog `track` describes its broadcast by, a new group whenever `catalog` reads differently. */
function writeCatalog(
  effect: Moq.Signals.Effect,
  track: Moq.Track.Producer,
  catalog: (watching: Moq.Signals.Effect) => Catalog
): void {
  let written = '';
  effect.run(watching => {
    const text = JSON.stringify(catalog(watching));
    if (text === written) return;
    written = text;
    const group = track.appendGroup();
    group.writeString(text);
    group.close();
  });
}

/**
 * Joins one exposure's renditions into its broadcast, on a connection of its own to the relay, reconnecting if it
 * drops, until the returned function closes it. New credentials are a new join, as they restart the renditions'
 * publishers too.
 */
function joinBroadcast(publisher: MoqPublisher): () => void {
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
    catalog: followCatalog(effect, consumed, rendition)
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

/** The joined broadcasts of the exposures MediaMTX publishes, each joined while its publisher is wanted. */
export class BroadcastJoiner {
  /** Each joined broadcast's close, by the publisher it joins for, as JSON. */
  private readonly joined = new Map<string, () => void>();

  /** Joins the broadcast of each publisher, and no other: a publisher that changed at all is joined anew. */
  set(publishers: MoqPublisher[]): void {
    const wanted = new Map(publishers.map(publisher => [JSON.stringify(publisher), publisher]));
    for (const [key, close] of this.joined) {
      if (wanted.has(key)) continue;
      close();
      this.joined.delete(key);
    }
    for (const [key, publisher] of wanted) {
      if (!this.joined.has(key)) this.joined.set(key, joinBroadcast(publisher));
    }
  }

  close(): void {
    this.set([]);
  }
}
