import { MediamtxConfigBuilder, type MediamtxConfig } from '@conservationtv/mediamtx';

export const MEDIAMTX_METRICS_ADDRESS = '127.0.0.1:9998';

/** Temporary local configuration until the studio supplies stream assignments. */
export const mediamtxConfig = new MediamtxConfigBuilder<void>((_params, config) => {
  const hardcoded = {
    logLevel: 'info',
    logDestinations: ['stdout'],
    api: false,
    metrics: true,
    metricsAddress: MEDIAMTX_METRICS_ADDRESS,
    authMethod: 'internal',
    authInternalUsers: [
      { user: 'any', permissions: [{ action: 'publish' }, { action: 'read' }] },
      { user: 'any', ips: ['127.0.0.1', '::1'], permissions: [{ action: 'metrics' }] }
    ],
    paths: { live: { source: 'publisher' } }
  } satisfies MediamtxConfig;
  Object.assign(config, hardcoded);
});
