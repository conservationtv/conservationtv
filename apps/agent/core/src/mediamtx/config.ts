import { MediamtxConfigBuilder, toYaml } from '@conservationtv/mediamtx';

// What every MediaMTX the agent runs is configured with, whichever it is: the gateway's (gateway/streams/config.ts) and
// the program MediaMTX's (output/obs/program.ts). Each assembles its config from builder steps, this one first.

/** Where a MediaMTX's control API and metrics page listen, on loopback. */
export interface MediamtxControlPorts {
  api: number;
  metrics: number;
}

/** What the common step needs: where the control API and metrics page listen. */
export interface MediamtxControl {
  ports: MediamtxControlPorts;
}

/**
 * Logs to stdout, which each runtime sends to its log file. The control API and metrics page on loopback only. Each
 * reader's queue of outgoing packets is 4096 rather than MediaMTX's 512.
 */
export const common = new MediamtxConfigBuilder<MediamtxControl>(({ ports }, config) => {
  config.logLevel = 'info';
  config.logDestinations = ['stdout'];
  config.writeQueueSize = 4096;
  config.api = true;
  config.apiAddress = `127.0.0.1:${String(ports.api)}`;
  config.metrics = true;
  config.metricsAddress = `127.0.0.1:${String(ports.metrics)}`;
});

/** The config file's text. Throws if the config is unfit to serve, naming what made it so. */
export async function renderYaml<P>(builder: MediamtxConfigBuilder<P>, params: P): Promise<string> {
  const { config, diagnostics } = await builder.render(params);
  const errors = diagnostics.filter(diagnostic => diagnostic.severity === 'error');
  if (errors.length > 0) {
    throw new Error(`The MediaMTX config is unfit to serve: ${errors.map(error => error.message).join('; ')}`);
  }
  return toYaml(config);
}
