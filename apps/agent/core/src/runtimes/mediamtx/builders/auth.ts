import { MediamtxConfigBuilder } from '@conservationtv/mediamtx';
import type { MediamtxListening, MediamtxServing } from '../config.ts';

/**
 * Readers and publishers admitted by the agent (auth.ts): those on this machine as they are, and the rest only by a
 * token for one action on one path, signed by the studio API as this agent, for this gateway. The control API and
 * metrics page listen on loopback for the agent alone, so they are never asked about.
 */
export const auth = new MediamtxConfigBuilder<MediamtxListening & MediamtxServing>((serving, config) => {
  if (serving.auth === undefined) return;
  config.authMethod = 'http';
  config.authHTTPAddress = serving.reach.authCallback;
  config.authHTTPExclude = [{ action: 'api' }, { action: 'metrics' }, { action: 'pprof' }];
});
