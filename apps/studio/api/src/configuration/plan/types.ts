import type { Rendition } from '../../topology/settings.ts';

// The shapes of a device's planned configuration (src/configuration/plan/index.ts), which mirror what the agent runs:
// MediaMTX paths, and MoQ publishers reading them.

/** A URL MediaMTX pulls a path from while it is read, such as a camera's, credentials included. */
export interface UrlSource {
  url: string;
}

/** Another path of the same MediaMTX, which a path is read from while it is read. */
export interface LocalSource {
  path: string;
}

/** Where a path gets its media. */
export type PathSource = UrlSource | LocalSource;

/** A path the agent's MediaMTX serves, delivering one rendition of an exposure. */
export interface PlannedPath {
  name: string;
  exposureId: string;
  rendition: Rendition;
  source: PathSource;
}

/** The `connect` ask (`organisations.streams.exposures.connect`) for where a publisher publishes, and its token. */
export interface PublisherConnect {
  id: string;
  streamId: string;
  exposureId: string;
  action: 'publish';
  protocol: 'moq';
}

/** One rendition a publisher publishes: read from `path`, a path its MediaMTX serves. */
export interface PublishedRendition {
  rendition: Rendition;
  path: string;
}

/**
 * An exposure the agent publishes by MoQ: the `connect` ask for where to (kept out of the plan, so a renewed token
 * leaves the plan as it was), how its gateway takes the renditions, and where each is read. `tracks`: one broadcast,
 * each rendition a track of it.
 */
export interface PlannedPublisher {
  exposureId: string;
  connect: PublisherConnect;
  layout: 'tracks';
  renditions: PublishedRendition[];
}

/** Something the topology asks for that the device's configuration leaves out, and why. */
export interface Diagnostic {
  /** What it is about, as reports name subjects: `exposure:<id>` or `gateway:<id>`. */
  subject: string;
  message: string;
}

/** How a MediaMTX checks a token: against this API's published keys, issued by this API, for its gateway. */
export interface MediamtxAuth {
  jwks: string;
  issuer: string;
  audience: string;
}

/** The MediaMTX gateway the device runs, and how it admits readers and publishers: by tokens this API signs for it. */
export interface MediamtxConfiguration {
  gatewayId: string;
  auth: MediamtxAuth;
}

/** A device that runs nothing: an agent that is not its network's active agent, or whose network has no MediaMTX gateway. */
export interface IdleConfiguration {
  state: 'idle';
}

/** The network's active agent: the MediaMTX gateway it runs, the paths that serves, and what it publishes from them. */
export interface ActiveConfiguration {
  state: 'active';
  mediamtx: MediamtxConfiguration;
  paths: PlannedPath[];
  publishers: PlannedPublisher[];
  diagnostics: Diagnostic[];
}

export type PlannedConfiguration = IdleConfiguration | ActiveConfiguration;
