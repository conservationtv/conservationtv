import { z } from 'zod';
import { RenditionSchema, type Rendition } from '../../topology/settings.ts';

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
export const PublisherConnectSchema = z
  .object({
    id: z.string(),
    streamId: z.string(),
    exposureId: z.string(),
    action: z.literal('publish'),
    protocol: z.literal('moq')
  })
  .meta({ id: 'PublisherConnect' });
export type PublisherConnect = z.output<typeof PublisherConnectSchema>;

/** One rendition a publisher publishes: read from `path`, a path its MediaMTX serves. */
export const PublishedRenditionSchema = z
  .object({ rendition: RenditionSchema, path: z.string() })
  .meta({ id: 'PublishedRendition' });
export type PublishedRendition = z.output<typeof PublishedRenditionSchema>;

/**
 * An exposure the agent publishes by MoQ: the `connect` ask for where to (kept out of the plan, so a renewed token
 * leaves the plan as it was), how its gateway takes the renditions, and where each is read. `tracks`: one broadcast,
 * each rendition a track of it.
 */
export const PlannedPublisherSchema = z
  .object({
    exposureId: z.string(),
    connect: PublisherConnectSchema,
    layout: z.literal('tracks'),
    renditions: z.array(PublishedRenditionSchema)
  })
  .meta({ id: 'Publisher' });
export type PlannedPublisher = z.output<typeof PlannedPublisherSchema>;

/** How a MediaMTX checks a token: signed by the agent's own identity, issued by this API, for its gateway. */
export const MediamtxAuthSchema = z.object({ issuer: z.string(), audience: z.string() }).meta({ id: 'MediamtxAuth' });
export type MediamtxAuth = z.output<typeof MediamtxAuthSchema>;

/** The hostname the gateway is reached at on its network, and the certificate its MediaMTX serves TLS with. */
export const MediamtxTlsSchema = z
  .object({
    hostname: z.string().describe('The hostname the certificate is for, which clients on the network use.'),
    certificate: z.string().describe('The PEM chain, the certificate first.'),
    privateKey: z.string().describe('The PEM private key, PKCS#8.'),
    notAfter: z.iso.datetime().describe('When the certificate expires; the studio API renews it before then.')
  })
  .meta({ id: 'MediamtxTls' });
export type MediamtxTls = z.output<typeof MediamtxTlsSchema>;

/**
 * The MediaMTX gateway the device runs, how it admits readers and publishers (by tokens this API signs as it), and
 * the hostname and certificate it serves TLS with, when the deployment issues them (src/gateways/certificates.ts).
 */
export interface MediamtxConfiguration {
  gatewayId: string;
  auth: MediamtxAuth;
  tls?: MediamtxTls;
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
}

export type PlannedConfiguration = IdleConfiguration | ActiveConfiguration;
