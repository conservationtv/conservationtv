import type { Rendition } from '../../topology/settings.ts';

// The shapes of a device's planned configuration (src/configuration/plan/index.ts).

/** A rendition the agent's MediaMTX serves: at `path`, pulled from `source` while it is read. */
export interface ServedRendition {
  rendition: Rendition;
  path: string;
  /** Where to pull it from, such as the camera's RTSP URL, credentials included. */
  source: string;
}

/** A rendition the agent publishes: read from `source`, a path its own MediaMTX serves. */
export interface PublishedRendition {
  rendition: Rendition;
  source: string;
}

/** An exposure the agent's MediaMTX serves, each rendition pulled from the stream's origin. */
export interface ServedExposure {
  ingest: 'pull';
  streamId: string;
  gatewayId: string;
  renditions: ServedRendition[];
}

/**
 * An exposure the agent publishes to its gateway by MoQ, reading each rendition from what its MediaMTX serves of
 * `upstreamExposureId`, and connecting (`organisations.streams.exposures.connect`) for credentials.
 */
export interface PublishedExposure {
  ingest: 'moq';
  streamId: string;
  gatewayId: string;
  upstreamExposureId: string;
  renditions: PublishedRendition[];
}

export type ExposureConfiguration = ServedExposure | PublishedExposure;

/** Something the topology asks for that the device's configuration leaves out, and why. */
export interface Diagnostic {
  /** What it is about, as reports name subjects: `exposure:<id>` or `gateway:<id>`. */
  subject: string;
  message: string;
}

/** Records why the exposure is left out of the configuration, or only partly in it. */
export type Diagnose = (message: string) => void;

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

export interface PlannedConfiguration {
  /** The device's organisation, which its connections are made under. */
  organisationId: string;
  mediamtx: MediamtxConfiguration | null;
  exposures: Record<string, ExposureConfiguration>;
  diagnostics: Diagnostic[];
}
