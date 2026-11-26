import { operationVersion, versionMismatch } from '@conservationtv/versioned-api/server';
import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import type { MetricsSpec } from '../../gateway/metrics/runtime.ts';
import type { RelayTrafficSpec } from '../../gateway/relay-traffic/runtime.ts';
import type { StreamsSpec } from '../../gateway/streams/runtime.ts';
import { useSystem } from '../../system/system.ts';

// The versions of `system.spec` released before an exposure was one path name the rendition each path and publisher
// delivers. A path may name one, and so a path's metrics; a publisher lists each it publishes, with the path it reads:
// only ever the one, `default`, which is what they say now.

/** The renditions those versions name. */
type Rendition = 'default' | 'data_saver' | 'balanced' | 'quality';

/** What a path may name, in those versions. */
interface NamedRendition {
  rendition?: string;
}

/** A path, as those versions say it: perhaps naming its rendition. */
type RenditionPath<Path> = Path & NamedRendition;

/** A rendition a publisher publishes, as those versions say it: read from a path. */
interface PublishedRendition {
  rendition: Rendition;
  path: string;
}

// No version says a pushed path's key digest (`keySha256`, gateway/streams/paths.ts): it admits nothing, but nothing
// reading the spec needs it either, and the versions released before it never named it.

/** A path as every version says it: without its key's digest. */
type SpokenPath = Omit<StreamsSpec['paths'][number], 'keySha256'>;

/** The `streams` spec without any path's key digest. */
function withoutKeyDigests({ paths, ...streams }: StreamsSpec) {
  const spoken = paths.map(({ keySha256: _keySha256, ...path }): SpokenPath => path);
  return { ...streams, paths: spoken };
}

/** The `streams` spec as those versions say it. */
function streamsWithRenditions(spec: StreamsSpec) {
  const { paths, publishers, ...streams } = withoutKeyDigests(spec);
  const named: RenditionPath<SpokenPath>[] = paths;
  const published = publishers.map(({ path, ...publisher }) => {
    const renditions: PublishedRendition[] = [{ rendition: 'default', path }];
    return { ...publisher, layout: 'tracks' as const, renditions };
  });
  return { ...streams, paths: named, publishers: published };
}

/**
 * The `relayTraffic` spec as the versions before 3 say it: without the exposures the agent watches on the relay, which
 * it covers without publishing, and which those versions never named. Their traffic is in `exposures`, as anyone's.
 */
function relayTrafficUnwatched({ watched: _watched, ...relayTraffic }: RelayTrafficSpec) {
  return relayTraffic;
}

/** The `metrics` spec as those versions say it. */
function metricsWithRenditions({ paths, ...metrics }: MetricsSpec) {
  const named: RenditionPath<MetricsSpec['paths'][number]>[] = paths;
  return { ...metrics, paths: named };
}

export default new Hono()
  .get(
    '/',
    describeRoute({
      operationId: 'system.get',
      ...operationVersion(1),
      summary: "Read the agent's runtimes",
      description:
        "Each runtime's live status, and whether it has accepted its latest spec. Live, never stored: after a restart " +
        'it is rebuilt from the runtimes.',
      responses: {
        200: { description: "Every runtime's status" },
        412: versionMismatch
      }
    }),
    async c => {
      const system = useSystem();
      // As it was before cameras were probed: each key named, in the order it always was.
      const { machine, streams, metrics, relayTraffic, obs, channels, show } = await system.status();
      c.header('Cache-Control', 'no-store');
      return c.json({ machine, streams, metrics, relayTraffic, obs, channels, show }, 200);
    }
  )
  .get(
    '/',
    describeRoute({
      operationId: 'system.get',
      ...operationVersion(2),
      summary: "Read the agent's runtimes",
      description:
        "Each runtime's live status, and whether it has accepted its latest spec. Live, never stored: after a restart " +
        'it is rebuilt from the runtimes. From this version, with `probes`: the cameras it asks whether they are there.',
      responses: {
        200: { description: "Every runtime's status" },
        412: versionMismatch
      }
    }),
    async c => {
      const system = useSystem();
      // As it was before the agent controlled cameras, listened to chat, or was told its peers.
      const { cameras: _cameras, chat: _chat, peers: _peers, ...status } = await system.status();
      c.header('Cache-Control', 'no-store');
      return c.json(status, 200);
    }
  )
  .get(
    '/',
    describeRoute({
      operationId: 'system.get',
      ...operationVersion(3),
      summary: "Read the agent's runtimes",
      description:
        "Each runtime's live status, and whether it has accepted its latest spec. Live, never stored: after a restart " +
        'it is rebuilt from the runtimes. From this version, with `cameras`, the cameras it controls and who holds ' +
        'each; `chat`, the chat it listens to for commands; and `peers`, how many devices it serves.',
      responses: {
        200: { description: "Every runtime's status" },
        412: versionMismatch
      }
    }),
    async c => {
      const system = useSystem();
      const status = await system.status();
      c.header('Cache-Control', 'no-store');
      return c.json(status, 200);
    }
  )
  .get(
    '/spec',
    describeRoute({
      operationId: 'system.spec',
      ...operationVersion(1),
      summary: "Read the agent's currently defined spec",
      responses: {
        200: { description: 'The current system specification' },
        412: versionMismatch
      }
    }),
    async c => {
      const system = useSystem();
      // As it was before cameras were probed, and while an exposure named its renditions.
      const { machine, streams, metrics, relayTraffic, obs, channels, show } = system.spec();
      const named = {
        ...(streams && { streams: streamsWithRenditions(streams) }),
        ...(metrics && { metrics: metricsWithRenditions(metrics) }),
        ...(relayTraffic && { relayTraffic: relayTrafficUnwatched(relayTraffic) })
      };
      c.header('Cache-Control', 'no-store');

      return c.json({ machine, ...named, obs, channels, show }, 200);
    }
  )
  .get(
    '/spec',
    describeRoute({
      operationId: 'system.spec',
      ...operationVersion(2),
      summary: "Read the agent's currently defined spec",
      description: 'From this version, with `probes`: the cameras it asks whether they are there.',
      responses: {
        200: { description: 'The current system specification' },
        412: versionMismatch
      }
    }),
    async c => {
      const system = useSystem();
      // As it was while an exposure named its renditions.
      const { streams, metrics, relayTraffic, ...spec } = system.spec();
      const named = {
        ...(streams && { streams: streamsWithRenditions(streams) }),
        ...(metrics && { metrics: metricsWithRenditions(metrics) }),
        ...(relayTraffic && { relayTraffic: relayTrafficUnwatched(relayTraffic) })
      };
      c.header('Cache-Control', 'no-store');

      return c.json({ ...spec, ...named }, 200);
    }
  )
  .get(
    '/spec',
    describeRoute({
      operationId: 'system.spec',
      ...operationVersion(3),
      summary: "Read the agent's currently defined spec",
      description:
        'With `probes`: the cameras it asks whether they are there. From this version an exposure is one path: no ' +
        "path names a rendition, and each of `streams`'s `publishers` names the one `path` it publishes; and " +
        '`relayTraffic` names the exposures it covers without publishing them, which it watches on the relay (`watched`).',
      responses: {
        200: { description: 'The current system specification' },
        412: versionMismatch
      }
    }),
    async c => {
      const system = useSystem();
      const { streams, ...spec } = system.spec();
      c.header('Cache-Control', 'no-store');

      return c.json({ ...spec, ...(streams && { streams: withoutKeyDigests(streams) }) }, 200);
    }
  );
