import { pipeline } from '@conservationtv/mediamtx';
import { ExposurePublisherSchema, type MediamtxAuth } from '@conservationtv/studio-sdk';
import { z } from 'zod';
import { common, renderYaml } from '../../mediamtx/config.ts';
import { auth } from './builders/auth.ts';
import { paths } from './builders/paths.ts';
import { publishers } from './builders/publishers.ts';
import { server } from './builders/server.ts';
import { tls } from './builders/tls.ts';
import type { MediamtxPaths, MediamtxPreviewPath } from './paths.ts';
import type { MediamtxPorts } from './ports.ts';
import type { MediamtxReach } from './reach.ts';
import type { TlsFiles } from './tls.ts';

// The config MediaMTX serves, assembled by the common step (mediamtx/config.ts) and the steps in builders/ from the
// ports its servers listen on, the paths the spec names and those shows' previews are published to, the exposures it
// publishes, who it admits and the certificate it serves TLS with.

/** Where MediaMTX's servers and the agent's listen (ports.ts), and how they reach each other (reach.ts). */
export interface MediamtxListening {
  ports: MediamtxPorts;
  reach: MediamtxReach;
}

/**
 * An exposure the agent publishes to a MoQ relay, from the path its own MediaMTX serves it at: the moq CLI pulls the
 * path over RTMP from MediaMTX itself (`reach.rtmp`) and publishes it as the one broadcast readers watch under the
 * exposure's path, with a catalog of its own saying what it carries. The agent reads that back through the relay
 * (relay-check.ts). `connect` carries its token as `?jwt=`, so new credentials restart the CLI: MediaMTX runs it for a
 * path with a source, from a path of its own whose config they change; the agent runs it for a pushed path (pushed.ts),
 * whose config they must not.
 */
export const MoqPublisherSchema = ExposurePublisherSchema.extend({
  /** The relay URL to dial, with the exposure's path and token, in place of the `connect` ask it came from. */
  connect: z.url(),
  /** The broadcast under it, which readers watch. */
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
  /** The paths shows' outputs publish their previews to; none when it is left out. */
  previews?: MediamtxPreviewPath[];
  auth?: MediamtxAuth;
  /** Absent when it publishes nothing. */
  publishing?: MoqPublishing;
  /**
   * The hook every pushed path runs while it is published, telling the agent so (pushed.ts), the same for as long as
   * the agent runs; absent, they run none.
   */
  available?: string;
  /** The certificate it serves TLS with (tls.ts); absent, it serves everything in the clear. */
  tls?: TlsFiles;
}

export const mediamtxConfig = pipeline(common, server, paths, publishers, auth, tls);

/** The config file's text. Throws if the config is unfit to serve, naming what made it so. */
export function renderConfig(params: MediamtxListening & MediamtxServing): Promise<string> {
  return renderYaml(mediamtxConfig, params);
}
