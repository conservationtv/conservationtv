import { getLogger } from '@logtape/logtape';
import * as Moq from '@moq/net';
import { z } from 'zod';
import type { MoqPublisher } from './config.ts';

const logger = getLogger(['agent', 'mediamtx', 'joiner']);

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

/**
 * Joins one exposure's renditions into its broadcast, on a connection of its own to the relay, reconnecting if it
 * drops, until the returned function closes it. Its joined catalog follows each rendition's whenever it is published,
 * across its publisher's restarts. New credentials are a new join, as they restart the renditions' publishers too.
 */
export function joinBroadcast(publisher: MoqPublisher): () => void {
  const effect = new Moq.Signals.Effect();
  const published = new Moq.Origin.Producer();
  const consumed = new Moq.Origin.Producer();
  const url = new URL(publisher.connect);
  const connection = new Moq.Connection({ url, publish: published.consume(), consume: consumed });
  const broadcast = published.createBroadcast(Moq.Path.from(publisher.broadcast));
  broadcast.announce();
  const catalogTrack = broadcast.createTrack(CATALOG_TRACK);
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

  // Each rendition's latest catalog, and the joined catalog last written: a new group only when it changes.
  const catalogs = new Map<string, Catalog>();
  let written = '';
  const update = (rendition: string, catalog: Catalog) => {
    catalogs.set(rendition, catalog);
    const known = publisher.renditions.flatMap(({ rendition: name }) => {
      const latest = catalogs.get(name);
      return latest === undefined ? [] : [{ rendition: name, catalog: latest }];
    });
    const text = JSON.stringify(joinCatalogs(known));
    if (text === written) return;
    written = text;
    const group = catalogTrack.appendGroup();
    group.writeString(text);
    group.close();
  };

  for (const { rendition } of publisher.renditions) {
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
          if (catalog.success) update(rendition, catalog.data);
        }
      });
    });
  }
  return () => effect.close();
}
