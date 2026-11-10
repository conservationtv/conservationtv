import { z } from 'zod';
import { RenditionSchema, type Rendition, type Settings } from '../../topology/settings.ts';

// The shapes of a device's planned configuration (src/configuration/plan/index.ts), which mirror what the agent runs:
// MediaMTX paths and MoQ publishers reading them, and OBS following a show.

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

/**
 * The `stats.connect` ask (`organisations.gateways.stats.connect`) for where to read what a gateway's relays carry of
 * the organisation's broadcasts: one for each gateway the agent publishes to that publishes stats.
 */
export const StatsConnectSchema = z.object({ id: z.string(), gatewayId: z.string() }).meta({ id: 'StatsConnect' });
export type StatsConnect = z.output<typeof StatsConnectSchema>;

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
 * The `mediamtx` runtime, which a network's active agent runs: the MediaMTX gateway on its network, how it admits
 * readers and publishers (by tokens this API signs as it), and the hostname and certificate it serves TLS with when the
 * deployment issues them (src/gateways/certificates.ts); the paths it serves, and what it publishes from them.
 */
export interface MediamtxConfiguration {
  gatewayId: string;
  auth: MediamtxAuth;
  tls?: MediamtxTls;
  paths: PlannedPath[];
  publishers: PlannedPublisher[];
  /** Where to read the traffic stats of the gateways it publishes to, for those that publish them. */
  stats: StatsConnect[];
}

/** The show an OBS output follows: the show, and the request a WebSocket follows it by, to sign as the device. */
export interface ObsShow {
  id: string;
  /** The `https:` (or, locally, `http:`) URL of the show's stream: signed as it is, and dialled as `wss:` (`ws:`). */
  url: string;
}

/**
 * The `obs` runtime, which a show's output runs (src/db/schemas/shows.ts): OBS, following the show it sends out and
 * playing what it places. Where to read each stream it is asked for when it is placed, not here. Agents built from
 * earlier releases read only `show`, `output` and `forwards`, so those keep their shape, and what is added is optional.
 */
export interface ObsConfiguration {
  show: ObsShow;
  /** What OBS encodes the program as: the show's encoding, which the program's fallback slate is encoded as too. */
  output: ObsOutput;
  /** Where the program goes out to: each channel the show has an enabled forward to. */
  forwards: ObsForward[];
  /** Where the program is published to be read from, as an exposure is: each of the show's previews. */
  previews?: ObsPreview[];
  /** How the program is recorded alongside streaming it, when the show has a recorder. */
  recording?: ObsRecording;
  /** What the agent reports about the program against. */
  program?: ObsProgram;
}

/** How the program is encoded: H.264 at a constant bitrate with AAC-LC 48 kHz stereo audio, as Twitch takes. */
export interface ObsOutput {
  width: number;
  height: number;
  fps: number;
  bitrateKbps: number;
  keyframeSeconds: number;
}

/**
 * A channel the program goes out to: its ingest (server URL and stream key) is read with `organisations.channels.ingest`.
 * `forwardId` names the forward (`forward:<forwardId>`) in what the agent reports about it.
 */
export interface ObsForward {
  organisationId: string;
  channelId: string;
  forwardId: string;
}

/**
 * The `connect` ask (`organisations.shows.previews.connect`) for where an output publishes a preview of its show's
 * program, and its token: by MoQ to a gateway that takes it, as tracks of one broadcast, otherwise by RTMP.
 */
export const PreviewConnectSchema = z
  .object({
    id: z.string(),
    showId: z.string(),
    previewId: z.string(),
    action: z.literal('publish'),
    protocol: z.string()
  })
  .meta({ id: 'PreviewConnect' });
export type PreviewConnect = z.output<typeof PreviewConnectSchema>;

/**
 * A preview the program is published to: its gateway, and the `connect` ask for where to (kept out of the plan, so a
 * renewed token leaves the plan as it was). `previewId` names it (`preview:<previewId>`) in what the agent reports.
 */
export interface ObsPreview {
  previewId: string;
  gatewayId: string;
  connect: PreviewConnect;
}

/**
 * The show's recorder: `obs`, OBS recording the program alongside streaming it, into the agent's data directory, with
 * the recorder's `params`. `recorderId` names it (`recorder:<recorderId>`) in what the agent reports.
 */
export interface ObsRecording {
  recorderId: string;
  kind: string;
  params: Settings;
}

/** The program as a subject of reports: `program:<showId>`. */
export interface ObsProgram {
  subjectId: string;
}

/** What a device runs: each runtime it is to run, by its key. A runtime left out is one it doesn't. */
export interface PlannedConfiguration {
  mediamtx?: MediamtxConfiguration;
  obs?: ObsConfiguration;
}
