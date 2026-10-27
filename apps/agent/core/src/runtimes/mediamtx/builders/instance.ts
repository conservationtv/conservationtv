import { MediamtxConfigBuilder } from '@conservationtv/mediamtx';
import type { MediamtxServing } from '../config.ts';

/** Where a config names the instance it was written for: a path of its own, as no other setting holds a name. */
export const INSTANCE_PATH_PREFIX = '_instance/';

/**
 * The instance MediaMTX was started as, named by a path nobody reads or publishes to, so the agent can ask the control
 * API whether what answers is the MediaMTX it started, and serves its config, rather than one left by another.
 */
export const instance = new MediamtxConfigBuilder<MediamtxServing>((serving, config) => {
  config.paths[`${INSTANCE_PATH_PREFIX}${serving.instance}`] = {};
});
