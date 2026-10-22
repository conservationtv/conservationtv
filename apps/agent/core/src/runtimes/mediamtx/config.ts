import { pipeline, toYaml } from '@conservationtv/mediamtx';
import { PublisherSchema, type MediamtxAuth } from '@conservationtv/studio-sdk';
import { z } from 'zod';
import { auth } from './builders/auth.ts';
import { paths } from './builders/paths.ts';
import { publishers } from './builders/publishers.ts';
import { server } from './builders/server.ts';
import type { MediamtxPaths } from './paths.ts';

// The config MediaMTX serves, assembled by the steps in builders/ from where its servers listen, the paths the spec
// names, the exposures it publishes and who it admits.

/** Where MediaMTX's own HTTP servers listen, and the agent's beside them, such as `127.0.0.1:9997`. */
export interface MediamtxAddresses {
  /** The control API. */
  api: string;
  /** The metrics page. */
  metrics: string;
  /** Where the agent answers MediaMTX's authentication requests (auth.ts). */
  authHttp: string;
}

/**
 * An exposure the agent publishes to a MoQ relay, from renditions its own MediaMTX serves. Each rendition is a
 * broadcast of its own under the exposure's path, which MediaMTX runs the moq CLI for, pulling it over RTMP from
 * loopback. The agent joins them (joiner.ts) into the one broadcast readers watch, whose catalog names each rendition's
 * tracks in its own broadcast. `connect` carries its token as `?jwt=`, so new credentials are a changed config, which
 * restarts the CLI.
 */
export const MoqPublisherSchema = PublisherSchema.extend({
  /** The relay URL to dial, with the exposure's path and token, in place of the `connect` ask it came from. */
  connect: z.url(),
  /** The joined broadcast under it. */
  broadcast: z.string().min(1)
}).strict();
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
