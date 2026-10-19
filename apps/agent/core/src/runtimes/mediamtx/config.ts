import { MediamtxConfigBuilder, pipeline, toYaml } from '@conservationtv/mediamtx';

// The config MediaMTX serves, assembled by steps. Fixed in code for now: what it serves will come from the spec.

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

/** Any path, published and read on MediaMTX's default listeners by anyone: a placeholder until paths come from the spec. */
const paths = new MediamtxConfigBuilder<MediamtxAddresses>((_addresses, config) => {
  config.paths.all_others = {};
});

export const mediamtxConfig = pipeline(server, paths);

/** The config file's text. Throws if the config is unfit to serve, naming what made it so. */
export async function renderConfig(addresses: MediamtxAddresses): Promise<string> {
  const { config, diagnostics } = await mediamtxConfig.render(addresses);
  const errors = diagnostics.filter(diagnostic => diagnostic.severity === 'error');
  if (errors.length > 0) {
    throw new Error(`The MediaMTX config is unfit to serve: ${errors.map(error => error.message).join('; ')}`);
  }
  return toYaml(config);
}
