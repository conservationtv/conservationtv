import { MediamtxConfigBuilder, pipeline, toYaml } from '@conservationtv/mediamtx';
import { z } from 'zod';
import { MEDIAMTX_AUTH_PATH, type MediamtxAuth } from './auth.ts';
import type { MediamtxPaths } from './paths.ts';

// The config MediaMTX serves, assembled by steps from where its servers listen, the paths the spec names and who it
// admits.

/** Where MediaMTX's own HTTP servers listen, and the agent's beside them, such as `127.0.0.1:9997`. */
export interface MediamtxAddresses {
  /** The control API. */
  api: string;
  /** The metrics page. */
  metrics: string;
  /** Where the agent answers MediaMTX's authentication requests (auth.ts). */
  authHttp: string;
}

/** MediaMTX's RTMP server, as a publisher on the same machine reaches it: its default listener, on loopback. */
const RTMP_LOOPBACK = 'rtmp://127.0.0.1:1935';

/** Logs to stdout, which the runtime sends to its log file; the control API and metrics page on `addresses`. */
const server = new MediamtxConfigBuilder<MediamtxAddresses>((addresses, config) => {
  config.logLevel = 'info';
  config.logDestinations = ['stdout'];
  config.api = true;
  config.apiAddress = addresses.api;
  config.metrics = true;
  config.metricsAddress = addresses.metrics;
});

/** One rendition of a published exposure: the MediaMTX path it is read from, on this MediaMTX. */
export const MoqRenditionSchema = z.strictObject({
  /** The rendition, which names its own broadcast under the exposure's path. */
  rendition: z.string().regex(/^[a-z0-9_]+$/u),
  /** The path it is served at on this MediaMTX. */
  source: z.string().min(1)
});
export type MoqRendition = z.output<typeof MoqRenditionSchema>;

/**
 * An exposure the agent publishes to a MoQ relay, from renditions its own MediaMTX serves. Each rendition is a
 * broadcast of its own under the exposure's path, which MediaMTX runs the moq CLI for, pulling it over RTMP from
 * loopback. The agent joins them (joiner.ts) into the one broadcast readers watch, whose catalog names each rendition's
 * tracks in its own broadcast. `connect` carries its token as `?jwt=`, so new credentials are a changed config, which
 * restarts the CLI.
 */
export const MoqPublisherSchema = z.strictObject({
  /** The exposure it publishes, which names its MediaMTX paths. */
  exposureId: z.uuid(),
  /** The relay URL to dial, with the exposure's path and token. */
  connect: z.url(),
  /** The joined broadcast under it. */
  broadcast: z.string().min(1),
  renditions: z.array(MoqRenditionSchema).min(1)
});
export type MoqPublisher = z.output<typeof MoqPublisherSchema>;

/** The exposures MediaMTX publishes, and the moq CLI, installed, that they run. */
export interface MoqPublishing {
  moq: string;
  publishers: MoqPublisher[];
}

/** What MediaMTX serves, and who it admits. */
export interface MediamtxServing {
  paths: MediamtxPaths;
  auth?: MediamtxAuth;
  /** Absent when it publishes nothing. */
  publishing?: MoqPublishing;
}

/**
 * Each path the spec names, and no other. A path with a `source` pulls it only while someone reads it, so a camera
 * streams nothing nobody watches. With no paths and no auth, any path at all (`all_others`), for a direct agent.
 */
const paths = new MediamtxConfigBuilder<MediamtxServing>((serving, config) => {
  // Any path when the spec names none and admits anyone; otherwise each it names, pulled from its source while it is
  // read, or (with none) pushed to by its publisher.
  if (serving.paths.length === 0 && serving.auth === undefined) config.paths.all_others = {};
  for (const path of serving.paths) {
    config.paths[path.name] = path.source === undefined ? {} : { source: path.source, sourceOnDemand: true };
  }
});

/**
 * A rendition's publisher: the moq CLI pulling it from this MediaMTX over RTMP, as a reader on loopback, which needs no
 * token (auth.ts), and publishing it as its own broadcast. MediaMTX runs it directly: none of its arguments has a space.
 */
function publisherCommand(publisher: MoqPublisher, rendition: MoqRendition, moq: string) {
  const publish = [moq, '--connect', publisher.connect, 'import', '--broadcast', rendition.rendition];
  return [...publish, 'rtmp', '--connect', `${RTMP_LOOPBACK}/${rendition.source}`].join(' ');
}

/**
 * Each rendition of each publisher, on a path of its own that runs it while MediaMTX runs, restarting it whenever it
 * exits: each is a broadcast, and a CLI, of its own. Nobody reads the path, and its name says whose it is.
 */
const publishers = new MediamtxConfigBuilder<MediamtxServing>((serving, config) => {
  if (serving.publishing === undefined) return;
  const { moq } = serving.publishing;
  for (const publisher of serving.publishing.publishers) {
    for (const rendition of publisher.renditions) {
      config.paths[`_publish/${publisher.exposureId}/${rendition.rendition}`] = {
        runOnInit: publisherCommand(publisher, rendition, moq),
        runOnInitRestart: true
      };
    }
  }
});

/**
 * Readers and publishers admitted by the agent (auth.ts): those on this machine as they are, and the rest only by a
 * token for one action on one path, signed by the studio API for this gateway. The control API and metrics page listen
 * on loopback for the agent alone, so they are never asked about.
 */
const auth = new MediamtxConfigBuilder<MediamtxAddresses & MediamtxServing>((serving, config) => {
  if (serving.auth === undefined) return;
  config.authMethod = 'http';
  config.authHTTPAddress = `http://${serving.authHttp}${MEDIAMTX_AUTH_PATH}`;
  config.authHTTPExclude = [{ action: 'api' }, { action: 'metrics' }, { action: 'pprof' }];
});

export const mediamtxConfig = pipeline(server, paths, publishers, auth);

/** The config file's text. Throws if the config is unfit to serve, naming what made it so. */
export async function renderConfig(params: MediamtxAddresses & MediamtxServing): Promise<string> {
  const { config, diagnostics } = await mediamtxConfig.render(params);
  const errors = diagnostics.filter(diagnostic => diagnostic.severity === 'error');
  if (errors.length > 0) {
    throw new Error(`The MediaMTX config is unfit to serve: ${errors.map(error => error.message).join('; ')}`);
  }
  return toYaml(config);
}
