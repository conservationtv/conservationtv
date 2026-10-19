import { MediamtxConfigBuilder, pipeline, toYaml } from '@conservationtv/mediamtx';
import type { MediamtxPaths } from './paths.ts';

// The config MediaMTX serves, assembled by steps from where its servers listen and the paths the spec names.

/** Where MediaMTX's own HTTP servers listen, such as `127.0.0.1:9997`. */
export interface MediamtxAddresses {
  /** The control API. */
  api: string;
  /** The metrics page. */
  metrics: string;
}

/** Logs to stdout, which the runtime sends to its log file; the control API and metrics page on `addresses`. */
const server = new MediamtxConfigBuilder<MediamtxAddresses>((addresses, config) => {
  config.logLevel = 'info';
  config.logDestinations = ['stdout'];
  config.api = true;
  config.apiAddress = addresses.api;
  config.metrics = true;
  config.metricsAddress = addresses.metrics;
});

/** What MediaMTX serves. */
export interface MediamtxServing {
  paths: MediamtxPaths;
}

/**
 * Each path the spec names, published and read on MediaMTX's default listeners by anyone, and no other. With none,
 * any path at all (`all_others`), as before paths came from the spec.
 */
const paths = new MediamtxConfigBuilder<MediamtxServing>((serving, config) => {
  if (serving.paths.length === 0) config.paths.all_others = {};
  for (const path of serving.paths) config.paths[path.name] = {};
});

export const mediamtxConfig = pipeline(server, paths);

/** The config file's text. Throws if the config is unfit to serve, naming what made it so. */
export async function renderConfig(params: MediamtxAddresses & MediamtxServing): Promise<string> {
  const { config, diagnostics } = await mediamtxConfig.render(params);
  const errors = diagnostics.filter(diagnostic => diagnostic.severity === 'error');
  if (errors.length > 0) {
    throw new Error(`The MediaMTX config is unfit to serve: ${errors.map(error => error.message).join('; ')}`);
  }
  return toYaml(config);
}
