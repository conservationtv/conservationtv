import { type BuildDiagnostic, MediamtxConfigBuilder, pipeline, toYaml } from '@conservationtv/mediamtx';

// The config MediaMTX runs with. Fixed for now: the stock protocols on their default ports, any path accepted, and the
// control API and metrics on loopback for the agent alone.

/** Where the agent reaches MediaMTX: its control API, and its Prometheus metrics. */
export interface ControlAddresses {
  api: string;
  metrics: string;
}

export const CONTROL: ControlAddresses = { api: '127.0.0.1:9997', metrics: '127.0.0.1:9998' };

interface ControlParams {
  control: ControlAddresses;
}

interface LoggingParams {
  logLevel: 'info' | 'debug';
}

interface PathParams {
  acceptAnyPath: boolean;
}

/** The control API and metrics, on loopback, where MediaMTX's default users may use them without credentials. */
const control = new MediamtxConfigBuilder<ControlParams>(({ control }, config) => {
  config.api = true;
  config.apiAddress = control.api;
  config.metrics = true;
  config.metricsAddress = control.metrics;
});

/** Logs to stdout, which the runtime points at a file of its own. */
const logging = new MediamtxConfigBuilder<LoggingParams>(({ logLevel }, config) => {
  config.logLevel = logLevel;
  config.logDestinations = ['stdout'];
});

/** A stream may be published on any path, as in MediaMTX's own sample config. */
const anyPath = new MediamtxConfigBuilder<PathParams>(({ acceptAnyPath }, config) => {
  if (acceptAnyPath) config.paths.all_others = {};
});

const steps = pipeline(control, logging, anyPath);

/** The rendered config, as mediamtx.yml, and what rendering it said. */
export interface RenderedConfig {
  yaml: string;
  diagnostics: BuildDiagnostic[];
}

/** Renders the config, refusing one with errors: MediaMTX shouldn't serve a config its steps couldn't build. */
export async function renderConfig(): Promise<RenderedConfig> {
  const { config, diagnostics } = await steps.render({ control: CONTROL, logLevel: 'info', acceptAnyPath: true });
  const errors = diagnostics.filter(diagnostic => diagnostic.severity === 'error');
  if (errors.length > 0) {
    const messages = errors.map(error => error.message);
    throw new Error(`The MediaMTX config is unfit to serve: ${messages.join('; ')}`);
  }
  return { yaml: toYaml(config), diagnostics };
}
