import { z } from 'zod';
import type { OutputControl } from '../../topology/output-recorder-kinds.ts';
import { RenditionSchema, type Rendition, type Settings } from '../../topology/settings.ts';

// The shapes of a device's planned configuration (src/configuration/plan/index.ts), which mirror what the agent runs:
// MediaMTX paths and MoQ publishers reading them, OBS sending an output out, and the show driving it.

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

/**
 * A path the agent's MediaMTX takes an output's preview on: the output's agent publishes the programme there, with a
 * token `organisations.outputs.previews.connect` signs as the agent for its gateway, and readers read it.
 */
export interface PlannedPreviewPath {
  name: string;
  previewId: string;
}

/**
 * A camera the agent probes, whether or not anything reads its streams, since it is otherwise pulled from only while
 * read: the URL to ask for a stream description (RTSP `DESCRIBE`), credentials included, and the subject to report
 * what it finds about (`camera.reachable`), the camera's device.
 */
export interface PlannedProbe {
  subjectId: string;
  url: string;
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
 * deployment issues them (src/gateways/certificates.ts); the paths it serves, what it publishes from them, and the
 * paths outputs publish their previews to.
 */
export interface MediamtxConfiguration {
  gatewayId: string;
  auth: MediamtxAuth;
  tls?: MediamtxTls;
  paths: PlannedPath[];
  publishers: PlannedPublisher[];
  /** Where to read the traffic stats of the gateways it publishes to, for those that publish them. */
  stats: StatsConnect[];
  /**
   * The outputs' previews delivered to its gateway, each a path publishers push to. Agents built from earlier releases
   * don't read it, and serve no previews.
   */
  previews?: PlannedPreviewPath[];
}

/**
 * The `mediamtx` runtime from version 2 of `deviceConfiguration.get`, which also probes the cameras of the streams it
 * delivers. Agents built from earlier releases ask for version 1, and don't probe.
 */
export interface ProbingMediamtxConfiguration extends MediamtxConfiguration {
  probes: PlannedProbe[];
}

/** The output an agent runs: the output, its organisation, and who drives its OBS's scenes. */
export interface ObsOutput {
  id: string;
  organisationId: string;
  /**
   * `show`: the `show` runtime drives the scenes, while the output follows a show, in a scene collection of the agent's
   * own. `external`: something outside the studio does, in a collection of its own, reading any of the organisation's
   * exposures through the agent; the agent leaves scenes alone.
   */
  control: OutputControl;
}

/**
 * The `obs` runtime, which an output's agent runs (src/db/schemas/outputs.ts): OBS, streaming whatever is on its
 * programme to the programme MediaMTX, which forwards, previews and records it, and plays the exposures OBS reads.
 * Who drives its scenes is `output.control`.
 */
export interface ObsConfiguration {
  output: ObsOutput;
  /** What OBS encodes the programme as, which the programme's fallback slate is encoded as too. */
  encoding: ObsEncoding;
  /** Where the programme goes out to: each channel the output has an enabled forward to. */
  forwards: ObsForward[];
  /** Where the programme is published to be read from, as an exposure is: each of the output's previews. */
  previews: ObsPreview[];
  /** How the programme is recorded alongside streaming it, when the output has a recorder. */
  recording?: ObsRecording;
  /** What the agent reports about the programme against. */
  program: ObsProgram;
}

/** How the programme is encoded: H.264 at a constant bitrate with AAC-LC 48 kHz stereo audio, as Twitch takes. */
export interface ObsEncoding {
  width: number;
  height: number;
  fps: number;
  bitrateKbps: number;
  keyframeSeconds: number;
}

/**
 * A channel the programme goes out to: its ingest (server URL and stream key) is read with
 * `organisations.channels.ingest`. `forwardId` names the forward (`forward:<forwardId>`) in what the agent reports
 * about it. `stats` says whether the channel's platform says anything of it (`organisations.channels.stats.get`,
 * Twitch's only), for the agent to report about the channel (`channel:<channelId>`).
 */
export interface ObsForward {
  organisationId: string;
  channelId: string;
  forwardId: string;
  stats: boolean;
}

/**
 * The `connect` ask (`organisations.outputs.previews.connect`) for where an output's agent publishes a preview of its
 * programme, and its token: by MoQ to a gateway that takes it, as tracks of one broadcast, otherwise by RTMP.
 */
export const PreviewConnectSchema = z
  .object({
    id: z.string(),
    outputId: z.string(),
    previewId: z.string(),
    action: z.literal('publish'),
    protocol: z.string()
  })
  .meta({ id: 'PreviewConnect' });
export type PreviewConnect = z.output<typeof PreviewConnectSchema>;

/**
 * A preview the programme is published to: its gateway, and the `connect` ask for where to (kept out of the plan, so a
 * renewed token leaves the plan as it was). `previewId` names it (`preview:<previewId>`) in what the agent reports.
 */
export interface ObsPreview {
  previewId: string;
  gatewayId: string;
  connect: PreviewConnect;
}

/**
 * A preview, from version 3 of `deviceConfiguration.get`, with its `signer`: the key ID (the agent's public ID) of the
 * agent whose key signs tokens for its gateway, the network's active agent for a MediaMTX gateway, so a token kept for it
 * is renewed when another agent takes the gateway over; null for a built-in gateway, or one no agent runs.
 */
export interface SignedObsPreview extends ObsPreview {
  signer: string | null;
}

/** The `obs` runtime, from version 3 of `deviceConfiguration.get`: each preview with its `signer`. */
export interface SignedObsConfiguration extends Omit<ObsConfiguration, 'previews'> {
  previews: SignedObsPreview[];
}

/**
 * The output's recorder: `obs`, OBS recording the programme alongside streaming it, into the agent's data directory,
 * with the recorder's `params`. `recorderId` names it (`recorder:<recorderId>`) in what the agent reports.
 */
export interface ObsRecording {
  recorderId: string;
  kind: string;
  params: Settings;
}

/** The programme as a subject of reports: `program:<outputId>`. */
export interface ObsProgram {
  subjectId: string;
}

/**
 * The `show` runtime, which an output's agent runs while the output follows a show under `show` control: the show,
 * and the request a WebSocket follows it by, to sign as the device. It drives the `obs` runtime's OBS.
 */
export interface ShowConfiguration {
  id: string;
  /** The `https:` (or, locally, `http:`) URL of the show's stream: signed as it is, and dialled as `wss:` (`ws:`). */
  url: string;
}

/** What a device runs: each runtime it is to run, by its key. A runtime left out is one it doesn't. */
export interface PlannedConfiguration {
  mediamtx?: MediamtxConfiguration;
  obs?: ObsConfiguration;
  show?: ShowConfiguration;
}

/** What a device runs, from version 2 of `deviceConfiguration.get`. */
export interface ProbingConfiguration {
  mediamtx?: ProbingMediamtxConfiguration;
  obs?: ObsConfiguration;
  show?: ShowConfiguration;
}

/** What a device runs, from version 3 of `deviceConfiguration.get`: its previews say who signs their tokens. */
export interface SignedConfiguration {
  mediamtx?: ProbingMediamtxConfiguration;
  obs?: SignedObsConfiguration;
  show?: ShowConfiguration;
}
