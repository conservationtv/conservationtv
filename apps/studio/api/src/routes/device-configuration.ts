import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import {
  type MediamtxConfiguration,
  type PlannedConfiguration,
  planConfiguration,
  type ProbingMediamtxConfiguration,
  withCameraUrls
} from '../configuration/plan/index.ts';
import { requireDevice, useDevice } from '../middleware/device.ts';
import { invalidSignature, operationVersion, unavailable, versionMismatch } from './openapi.ts';

// What the signing device should be doing, derived from the topology now (src/configuration/plan/index.ts). Devices ask
// for it signed, as they do for `iroh-sessions`, and again whenever they want to notice a change.
/** The `mediamtx` runtime as version 1 returns it: as it was before cameras were probed. */
function withoutProbes(mediamtx: ProbingMediamtxConfiguration): MediamtxConfiguration {
  const { gatewayId, auth, tls, paths, publishers, stats, previews } = mediamtx;
  return { gatewayId, auth, tls, paths, publishers, stats, previews };
}

const DESCRIPTION =
  "What the signing device runs, derived from the topology whenever it asks: a section for each runtime it is to run, and none for those it isn't. `mediamtx`, for a network's active agent on a network with a MediaMTX gateway: the gateway (and how it checks readers' tokens), the MediaMTX `paths` it serves, each delivering one rendition of an exposure from a `source` that is a URL to pull while it is read (a camera's, credentials included) or another of its paths, the `publishers` it runs, each publishing an exposure by MoQ in the `layout` its gateway takes, reading each rendition from one of its paths, with the `connect` ask for where to publish and the token to do so, and the `stats` asks (`organisations.gateways.stats.connect`) for the traffic stats of the gateways it publishes to that publish them. `obs`, for the agent an output runs on (`organisations.outputs.setDevice`): the `output`, its organisation, and its `control`, who drives OBS's scenes (`show`: the `show` runtime; `external`: something outside the studio, which reads how to reach OBS from `organisations.outputs.control.get`, the agent having reported it with `organisations.outputs.control.report`, and plays any of the organisation's exposures through it), the `encoding` the programme is sent at, the `forwards`, one for each channel the output has an enabled forward to, naming the forward and the channel whose server and stream key it reads with `organisations.channels.ingest`, and whether the channel has `stats` it reads with `organisations.channels.stats.get` and reports about `channel:<channelId>`, the `previews` it publishes the programme to, each with the `connect` ask (`organisations.outputs.previews.connect`) for where to and its token, the `recording` it makes alongside streaming, when the output has a recorder, and the `program`'s subject ID, to report about it against; it reads each exposure OBS plays with `organisations.streams.exposures.connect`. `show`, for that agent while the output follows a show under `show` control: the show's `id`, and the `url` it signs a WebSocket upgrade to as the device to follow it. A device with no section runs nothing. Any device: the request carries an RFC 9421 HTTP Message Signature by the device's Ed25519 identity, as for `reports.submit`, over an empty body.";

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
      description: DESCRIPTION,
      responses
    }),
    requireDevice,
    async c => {
      const device = useDevice();
      const planned = await planConfiguration(device);
      const { mediamtx, obs, show } = withCameraUrls(planned);
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
      description: `${DESCRIPTION} From this version, \`mediamtx\` also has the \`probes\` it runs: each camera its streams come from, with the URL to ask for a stream description every few seconds, credentials included, and the subject to report whether it answered about (\`camera.reachable\`), so a camera nothing is reading is still known to be there.`,
      responses
    }),
    requireDevice,
    async c => {
      const device = useDevice();
      const planned = await planConfiguration(device);
      const configuration = withCameraUrls(planned);
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
      description: `${DESCRIPTION} From this version the agent is given its cameras as they are registered, rather than URLs made from them. \`cameras\`, for a network's active agent: the cameras on its network and those its streams are pulled from, each with the \`settings\` its driver reads, its \`credentials\`, and its \`state\`, and the \`issuer\` of the grants that admit commands to them: it controls an \`enabled\` one for whoever presents a grant this API signed as the agent, for the agent, to the presenting device (\`organisations.cameras.control.connect\`). A \`mediamtx\` path's \`source\` is then a \`cameraId\` to pull at the path's rendition, or another path, and each of its \`probes\` a \`cameraId\` to ask at its \`default\` rendition. \`chat\`, for an output's agent while the output goes out to a Twitch channel and the organisation has chat commands: the \`channels\` whose chat to listen to, by login, and the \`commands\` to listen for, each told to this API when used (\`organisations.chatCommands.trigger\`). \`peers\`, always: every other agent and browser of the organisation, by endpoint ID, with whether each may connect directly or through the relay alone; the agent serves no one else. Each of \`obs\`'s \`previews\` also has its \`signer\`: the key ID of the agent that signs tokens for its gateway, the network's active agent for a MediaMTX gateway, or null for a built-in gateway or one no agent runs; a token kept for a preview is asked for again when it changes, as when another agent becomes the network's active agent.`,
      responses
    }),
    requireDevice,
    async c => {
      const device = useDevice();
      const configuration = await planConfiguration(device);
      c.header('Cache-Control', 'no-store');
      return c.json(configuration, 200);
    }
  );
