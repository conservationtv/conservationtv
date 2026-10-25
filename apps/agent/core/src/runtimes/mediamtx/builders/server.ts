import { MediamtxConfigBuilder } from '@conservationtv/mediamtx';
import type { MediamtxAddresses } from '../config.ts';

/** Logs to stdout, which the runtime sends to its log file; the control API and metrics page on `addresses`. */
export const server = new MediamtxConfigBuilder<MediamtxAddresses>((addresses, config) => {
  config.logLevel = 'info';
  config.logDestinations = ['stdout'];
  config.api = true;
  config.apiAddress = addresses.api;
  config.metrics = true;
  config.metricsAddress = addresses.metrics;
});
