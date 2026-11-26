import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import {
  type MediamtxConfiguration,
  type PlannedConfiguration,
  planConfiguration,
  type ProbingMediamtxConfiguration,
  withCameraUrls,
  withPathRenditions,
  withRelays
} from '../configuration/plan/index.ts';
import { requireDevice, useDevice } from '../middleware/device.ts';
import { invalidSignature, operationVersion, unavailable, versionMismatch } from './openapi.ts';

// What the signing device should be doing, derived from the topology now (src/configuration/plan/index.ts). Devices ask
// for it signed, as they do for `iroh-sessions`, and again whenever they want to notice a change. Agents built before
// version 4 still ask for earlier ones, which name each path's and publisher's rendition: always `default`.
/** The `mediamtx` runtime as version 1 returns it: as it was before cameras were probed. */
function withoutProbes(mediamtx: ProbingMediamtxConfiguration): MediamtxConfiguration {
  const { gatewayId, auth, tls, paths, publishers, stats, previews } = mediamtx;
  return { gatewayId, auth, tls, paths, publishers, stats, previews };
}

const DESCRIPTION =
  "What the signing device runs, derived from the topology whenever it asks: a section for each runtime it is to run, and none for those it isn't. `mediamtx`, for a network's active agent on a network with a MediaMTX gateway: the gateway (and how it checks readers' tokens), the MediaMTX `paths` it serves, each delivering an exposure from a `source` that is a URL to pull while it is read (a camera's, credentials included) or another of its paths, the `publishers` it runs, each publishing an exposure by MoQ from one of its paths, with the `connect` ask for where to publish and the token to do so, and the `stats` asks (`organisations.gateways.stats.connect`) for the traffic stats of the gateways it publishes to that publish them. `obs`, for the agent an output runs on (`organisations.outputs.setDevice`): the `output`, its organisation, and its `control`, who drives OBS's scenes (`show`: the `show` runtime; `external`: something outside the studio, which reads how to reach OBS from `organisations.outputs.control.get`, the agent having reported it with `organisations.outputs.control.report`, and plays any of the organisation's exposures through it), the `encoding` the programme is sent at, the `forwards`, one for each channel the output has an enabled forward to, naming the forward and the channel whose server and stream key it reads with `organisations.channels.ingest`, and whether the channel has `stats` it reads with `organisations.channels.stats.get` and reports about `channel:<channelId>`, the `previews` it publishes the programme to, each with the `connect` ask (`organisations.outputs.previews.connect`) for where to and its token, the `recording` it makes alongside streaming, when the output has a recorder, and the `program`'s subject ID, to report about it against; it reads each exposure OBS plays with `organisations.streams.exposures.connect`. `show`, for that agent while the output follows a show under `show` control: the show's `id`, and the `url` it signs a WebSocket upgrade to as the device to follow it. A device with no section runs nothing. Any device: the request carries an RFC 9421 HTTP Message Signature by the device's Ed25519 identity, as for `reports.submit`, over an empty body.";

/** How the versions before 4 say what a path and a publisher deliver. */
const RENDITIONS_DESCRIPTION =
  'Each path names the `rendition` of its exposure it delivers, and each publisher the `layout` its gateway takes (`tracks`) and the `renditions` it publishes, each read from one of its paths: always the one, `default`.';

/** What version 3 adds, which later versions keep. */
const CAMERAS_DESCRIPTION =
  "From version 3 the agent is given its cameras as they are registered, rather than URLs made from them. `cameras`, for a network's active agent: the cameras on its network and those its streams are pulled from, each with the `settings` its driver reads, its `credentials`, and its `state`, and the `issuer` of the grants that admit commands to them: it controls an `enabled` one for whoever presents a grant this API signed as the agent, for the agent, to the presenting device (`organisations.cameras.control.connect`). A `mediamtx` path's `source` is then a `cameraId` to pull, or another path, and each of its `probes` a `cameraId` to ask. `chat`, for an output's agent while the output goes out to a Twitch channel and the organisation has chat commands: the `channels` whose chat to listen to, by login, and the `commands` to listen for, each told to this API when used (`organisations.chatCommands.trigger`). `peers`, always: every other agent and browser of the organisation, by endpoint ID, with whether each may connect directly or through the relay alone; the agent serves no one else. Each of `obs`'s `previews` also has its `signer`: the key ID of the agent that signs tokens for its gateway, the network's active agent for a MediaMTX gateway, or null for a built-in gateway or one no agent runs; a token kept for a preview is asked for again when it changes, as when another agent becomes the network's active agent.";

/** What version 4 changes. */
const RELAYS_DESCRIPTION =
  "From this version each of `mediamtx`'s `publishers` names the one `path` it reads, and publishes it as one broadcast, whose catalog says what it carries; and `mediamtx` has no `stats`. `relays`, for an agent that covers some of the organisation's exposures on a gateway whose relays publish stats (each such exposure is covered by exactly one agent: the one that delivers it, otherwise the organisation's oldest active agent): the `stats` asks (`organisations.gateways.stats.connect`) for each such gateway, and the exposures it covers but does not publish (`watched`), each with the `connect` ask (`organisations.streams.exposures.connect`, `action: read`) to read its catalog back through the relay by. It reports what the relays carry of every exposure it covers, and whether they have it.";

/** What version 4 says of chat. */
const STANDARD_CHAT_DESCRIPTION =
  "`chat` also lists the `standard` commands the organisation has on (`organisations.chatCommands.standard.list`), each by every word it is used by, with its `audience`, its `cooldownSeconds` and the `target` it rests per (a `camera`, or the `show`), and is there whenever the output listens to a Twitch channel's chat: the channels it goes out to and its control channels (`organisations.outputs.controlChannels.create`). A use of any command, its own or standard, is told by its word (`organisations.chatCommands.uses.create`).";

const responses = {
  200: { description: 'The configuration' },
  401: invalidSignature,
  412: versionMismatch,
  503: unavailable
};

export default new Hono()
  .get(
    '/',
    describeRoute({
      operationId: 'deviceConfiguration.get',
      ...operationVersion(1),
      summary: "Read the signing device's configuration",
      description: `${DESCRIPTION} ${RENDITIONS_DESCRIPTION}`,
      responses
    }),
    requireDevice,
    async c => {
      const device = useDevice();
      const planned = await planConfiguration(device);
      const { mediamtx, obs, show } = withCameraUrls(withPathRenditions(planned));
      const configuration: PlannedConfiguration = { mediamtx: mediamtx && withoutProbes(mediamtx), obs, show };
      c.header('Cache-Control', 'no-store');
      return c.json(configuration, 200);
    }
  )
  .get(
    '/',
    describeRoute({
      operationId: 'deviceConfiguration.get',
      ...operationVersion(2),
      summary: "Read the signing device's configuration",
      description: `${DESCRIPTION} ${RENDITIONS_DESCRIPTION} From this version, \`mediamtx\` also has the \`probes\` it runs: each camera its streams come from, with the URL to ask for a stream description every few seconds, credentials included, and the subject to report whether it answered about (\`camera.reachable\`), so a camera nothing is reading is still known to be there.`,
      responses
    }),
    requireDevice,
    async c => {
      const device = useDevice();
      const planned = await planConfiguration(device);
      const configuration = withCameraUrls(withPathRenditions(planned));
      c.header('Cache-Control', 'no-store');
      return c.json(configuration, 200);
    }
  )
  .get(
    '/',
    describeRoute({
      operationId: 'deviceConfiguration.get',
      ...operationVersion(3),
      summary: "Read the signing device's configuration",
      description: `${DESCRIPTION} ${RENDITIONS_DESCRIPTION} ${CAMERAS_DESCRIPTION}`,
      responses
    }),
    requireDevice,
    async c => {
      const device = useDevice();
      const planned = await planConfiguration(device);
      const configuration = withPathRenditions(planned);
      c.header('Cache-Control', 'no-store');
      return c.json(configuration, 200);
    }
  )
  .get(
    '/',
    describeRoute({
      operationId: 'deviceConfiguration.get',
      ...operationVersion(4),
      summary: "Read the signing device's configuration",
      description: `${DESCRIPTION} ${CAMERAS_DESCRIPTION} ${RELAYS_DESCRIPTION} ${STANDARD_CHAT_DESCRIPTION}`,
      responses
    }),
    requireDevice,
    async c => {
      const device = useDevice();
      const planned = await planConfiguration(device);
      const configuration = withRelays(planned);
      c.header('Cache-Control', 'no-store');
      return c.json(configuration, 200);
    }
  );
