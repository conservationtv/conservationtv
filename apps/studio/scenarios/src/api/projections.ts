import { STANDARD_COMMANDS } from '@conservationtv/chat';
import {
  MetricQueryV1ParamsSchema,
  type AccountGetV1Output,
  type AgentListV1Output,
  type CameraListV2Output,
  type ChannelListV1Output,
  type ChatCommandListV2Output,
  type StandardListV1Output,
  type ControlGetV1Output,
  type DeviceListAddressesV1Output,
  type DeviceListV2Output,
  type GatewayListEndpointsV1Output,
  type GatewayListV1Output,
  type InvitationGetV1Output,
  type InvitationListMineV1Output,
  type InvitationListV1Output,
  type LiveListV1Output,
  type MemberListV1Output,
  type MetricQueryV1Output,
  type NetworkListV1Output,
  type OrganisationGetV1Output,
  type OrganisationListV1Output,
  type OutputListV2Output,
  type ShowGetV2Output,
  type ShowListV2Output,
  type StateListV2Output,
  type StatusGetV1Output,
  type StreamListV2Output,
  type TopologyGetV2Output
} from '@conservationtv/studio-sdk/versions';
import { exposureSubject } from '@conservationtv/reports';
import type { JSONValue } from 'hono/utils/types';

/** The standard chat commands as an organisation has them when it hasn't changed them. */
const STANDARD_LISTED: StandardListV1Output['commands'] = STANDARD_COMMANDS.map(command => ({
  ...command,
  aliases: [...command.aliases],
  enabled: true,
  changedAt: null
}));

// The API's own status rule, so the status the UI shows is the one the API would work out from these states. It is
// pure (it reads only the lists it is given), and imported from the API's source because the API doesn't export it;
// as are a show's lineup and takeover mix (src/shows/resolve.ts), and how the versions from before renditions were
// removed say a stream (src/topology/renditions.ts).
import { organisationStatus } from '../../../api/src/health/status.ts';
import { addableStreams, lineupEntries, takeoverMix } from '../../../api/src/shows/resolve.ts';
import { withStreamRenditions } from '../../../api/src/topology/renditions.ts';
import { BUILTIN_GATEWAY_ID } from '../world/generate.ts';
import { queryMetrics } from '../world/metrics.ts';
import { focusOrganisation, type World } from '../world/model.ts';
import { placedStreamsOf, showFactsOf, unreachableOf, type ShowSources } from '../world/shows.ts';

// Each operation the mock API answers, as a selection from the world: `<operation ID>@<version>` to what the API's
// handler would return. The return types are the generated SDK's, so a projection that falls behind the contract fails
// typecheck; the server also checks every response against the contract's schema as it sends it (src/api/contract.ts).

/** A failure, answered with the API's error body. */
export class ApiError {
  constructor(
    readonly status: number,
    readonly error: string,
    readonly description: string
  ) {}
}

export interface Call {
  world: World;
  /** The path's parameters, by the names the contract gives them. */
  params: Record<string, string>;
  query: URLSearchParams;
  /** The request's JSON body, unparsed: a projection that reads it parses it. */
  body: JSONValue | undefined;
}

/** What a projection answers with: one of the contract's responses. */
export type ProjectedResponse =
  | AccountGetV1Output
  | AgentListV1Output
  | CameraListV2Output
  | ChannelListV1Output
  | ChatCommandListV2Output
  | StandardListV1Output
  | ControlGetV1Output
  | DeviceListAddressesV1Output
  | DeviceListV2Output
  | GatewayListEndpointsV1Output
  | GatewayListV1Output
  | InvitationGetV1Output
  | InvitationListMineV1Output
  | InvitationListV1Output
  | LiveListV1Output
  | MemberListV1Output
  | MetricQueryV1Output
  | NetworkListV1Output
  | OrganisationGetV1Output
  | OrganisationListV1Output
  | OutputListV2Output
  | ShowGetV2Output
  | ShowListV2Output
  | StateListV2Output
  | StatusGetV1Output
  | StreamListV2Output
  | TopologyGetV2Output;

export type Projection = (call: Call) => ProjectedResponse;

/** A metrics query's body, as the contract has it: its parameters but the organisation, which is in the path. */
const MetricQueryBodySchema = MetricQueryV1ParamsSchema.omit({ id: true });

const notFound = (what: string) => new ApiError(404, 'not_found', `No ${what} by that ID`);

/** Live connections (relays, agents over iroh, camera control) aren't simulated: they fail as an unreachable relay would. */
const unsimulated = (): never => {
  throw new ApiError(503, 'unavailable', 'Live connections are not simulated in scenarios');
};

const BUILTIN_GATEWAY = {
  id: BUILTIN_GATEWAY_ID,
  builtin: true,
  name: 'conservation.tv',
  kind: 'moq-relay',
  networkId: null,
  settings: {},
  createdAt: null
} as const;

/**
 * The organisation the call names: the world's own, or another the account is in, which has nothing in it. Any other
 * is not found, as the API's row-level security would have it.
 */
function scope(call: Call): World {
  const id = call.params.id;
  const [own, ...others] = call.world.organisations;
  if (own && id === own.id) return call.world;
  if (others.some(organisation => organisation.id === id)) {
    return {
      ...call.world,
      networks: [],
      devices: [],
      agents: [],
      cameras: [],
      gateways: [],
      streams: [],
      shows: [],
      showStreams: {},
      sharedStreams: [],
      personalStreams: [],
      publishing: [],
      outputs: [],
      channels: [],
      chatCommands: [],
      states: [],
      members: [],
      invitations: []
    };
  }
  throw notFound('organisation');
}

/** What the world's shows are resolved from: its organisation's lists and states. */
function sourcesOf(world: World): ShowSources {
  return { ...world, organisationId: focusOrganisation(world)?.id ?? '' };
}

/** The organisation's status, by the API's own rule: each show is the streams its state places. */
export function statusOf(world: World): StatusGetV1Output {
  const sources = sourcesOf(world);
  return organisationStatus({
    devices: world.devices,
    cameras: world.cameras,
    agents: world.agents,
    gateways: [BUILTIN_GATEWAY, ...world.gateways],
    streams: world.streams,
    shows: world.shows.map(show => ({ id: show.id, name: show.name, streams: placedStreamsOf(sources, show) })),
    outputs: world.outputs,
    channels: world.channels,
    states: world.states.map(state => ({ ...state, observedAt: new Date(state.observedAt) })),
    // The built-in relay publishes stats, so an agent covers every exposure there, as the API has it.
    statsGatewayIds: [BUILTIN_GATEWAY_ID]
  });
}

/**
 * Whether a delivery is live now, as its gateway would say, from its state, so the live list and the status agree:
 * conservation.tv has it while its state says it is delivering (active, fresh, not failing), and a MediaMTX gateway's
 * path was ready in its agent's last report when that is fresh, and it cannot say (null) without one.
 */
function liveFrom(gatewayId: string, state: World['states'][number] | undefined): boolean | null {
  const fresh = state?.freshness === 'fresh';
  if (gatewayId !== BUILTIN_GATEWAY_ID && !fresh) return null;
  return fresh && state?.activity === 'active' && state.health !== 'unhealthy';
}

/** Which of the organisation's deliveries are live now, oldest first, each as its gateway says (`liveFrom`). */
export function liveOf(world: World): LiveListV1Output {
  const states = new Map(world.states.map(state => [state.subjectId, state]));
  const checkedAt = new Date(new Date(world.now).getTime() - 2_000).toISOString();
  const exposures = world.streams.flatMap(stream =>
    stream.exposures.map(({ id, gatewayId }) => ({
      id,
      streamId: stream.id,
      gatewayId,
      live: liveFrom(gatewayId, states.get(exposureSubject(id))),
      checkedAt
    }))
  );
  return { exposures: exposures.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) };
}

/**
 * A show as `organisations.shows.get` v2 reads it: its row, its lineup, how it mixes its takeover, and which of the
 * streams it needs each output following it with an agent cannot reach.
 */
function showOf(world: World, showId: string): ShowGetV2Output {
  const show = world.shows.find(candidate => candidate.id === showId);
  if (!show) throw notFound('show');
  const sources = sourcesOf(world);
  const facts = showFactsOf(sources, show);
  const networks = new Map<string, string | null>([
    [BUILTIN_GATEWAY_ID, null],
    ...world.gateways.map((gateway): [string, string | null] => [gateway.id, gateway.networkId])
  ]);
  const unreachable = unreachableOf(sources, world, show, networks);
  const lineup = lineupEntries(facts);
  return { ...show, lineup, addable: addableStreams(facts), takeoverMix: takeoverMix(facts), unreachable };
}

/**
 * The topology, as its version from before shows had state says it: streams without codes, each delivery offering
 * the one rendition, outputs without an input gateway, and each show's `placed`, every delivery of each stream its
 * state places, in its order.
 */
function topologyOf(world: World): TopologyGetV2Output {
  const sources = sourcesOf(world);
  const deliveries = (streamId: string) =>
    (world.streams.find(stream => stream.id === streamId)?.exposures ?? []).map(exposure => exposure.id);
  return {
    shows: world.shows.map(show => ({
      name: show.name,
      id: show.id,
      createdAt: show.createdAt,
      outputs: show.outputs,
      placed: placedStreamsOf(sources, show).flatMap(deliveries)
    })),
    networks: world.networks,
    // The topology's devices don't say which member a browser belongs to.
    devices: world.devices.map(({ id, kind, name, networkId, publicKey, publicId, createdAt }) => ({
      id,
      kind,
      name,
      networkId,
      publicKey,
      publicId,
      createdAt
    })),
    gateways: [BUILTIN_GATEWAY, ...world.gateways],
    streams: world.streams.map(({ code: _code, ...stream }) => withStreamRenditions(stream)),
    outputs: world.outputs.map(({ inputGatewayId: _inputGatewayId, ...output }) => output),
    channels: world.channels,
    states: world.states
  };
}

/** The projections, by `<operation ID>@<version>`. */
export const PROJECTIONS = new Map(
  Object.entries({
    'account.get@1': ({ world }): AccountGetV1Output => ({
      id: world.viewer.id,
      name: world.viewer.name,
      email: world.viewer.email,
      emailVerified: true,
      image: null,
      createdAt: world.viewer.createdAt
    }),
    'invitations.listMine@1': ({ world }): InvitationListMineV1Output => ({ invitations: world.myInvitations }),
    'invitations.get@1': ({ world, params }): InvitationGetV1Output => {
      const invitation = world.myInvitations.find(candidate => candidate.id === params.id);
      if (!invitation) throw notFound('invitation');
      return { ...invitation, needsCode: false };
    },
    'organisations.list@1': ({ world }): OrganisationListV1Output => ({ organisations: world.organisations }),
    'organisations.get@1': (call): OrganisationGetV1Output => {
      scope(call);
      const organisation = call.world.organisations.find(candidate => candidate.id === call.params.id);
      if (!organisation) throw notFound('organisation');
      return { id: organisation.id, name: organisation.name, createdAt: organisation.createdAt };
    },
    'organisations.members.list@1': (call): MemberListV1Output => ({ members: scope(call).members }),
    'organisations.invitations.list@1': (call): InvitationListV1Output => ({ invitations: scope(call).invitations }),
    'organisations.networks.list@1': (call): NetworkListV1Output => ({ networks: scope(call).networks }),
    'organisations.devices.list@2': (call): DeviceListV2Output => {
      const kind = call.query.get('kind');
      return { devices: scope(call).devices.filter(device => !kind || device.kind === kind) };
    },
    'organisations.devices.listAddresses@1': (call): DeviceListAddressesV1Output => {
      const world = scope(call);
      const deviceId = call.params.deviceId ?? '';
      if (!world.devices.some(device => device.id === deviceId)) throw notFound('device');
      return { addresses: world.addresses[deviceId] ?? [] };
    },
    'organisations.devices.getKeyPair@1': unsimulated,
    'organisations.cameras.list@2': (call): CameraListV2Output => ({ cameras: scope(call).cameras }),
    'organisations.agents.list@1': (call): AgentListV1Output => {
      const networkId = call.query.get('networkId');
      return { agents: scope(call).agents.filter(agent => !networkId || agent.networkId === networkId) };
    },
    'organisations.gateways.list@1': (call): GatewayListV1Output => {
      const networkId = call.query.get('networkId');
      const own = scope(call).gateways.filter(gateway => !networkId || gateway.networkId === networkId);
      return { gateways: networkId ? own : [BUILTIN_GATEWAY, ...own] };
    },
    'organisations.gateways.listEndpoints@1': (call): GatewayListEndpointsV1Output => {
      const world = scope(call);
      // The built-in gateway is always there; any other must be the organisation's.
      const gatewayId = call.params.gatewayId ?? '';
      if (gatewayId !== BUILTIN_GATEWAY_ID && !world.gateways.some(gateway => gateway.id === gatewayId))
        throw notFound('gateway');
      return { endpoints: world.endpoints[gatewayId] ?? [] };
    },
    'organisations.streams.list@2': (call): StreamListV2Output => ({ streams: scope(call).streams }),
    'organisations.streams.live.list@1': (call): LiveListV1Output => liveOf(scope(call)),
    'organisations.shows.list@2': (call): ShowListV2Output => ({ shows: scope(call).shows }),
    'organisations.shows.get@2': (call): ShowGetV2Output => showOf(scope(call), call.params.showId ?? ''),
    'organisations.outputs.list@2': (call): OutputListV2Output => ({ outputs: scope(call).outputs }),
    'organisations.outputs.control.get@1': (call): ControlGetV1Output => {
      const world = scope(call);
      const control = world.outputControls[call.params.outputId ?? ''];
      if (!control) throw notFound('control report');
      return control;
    },
    'organisations.channels.list@1': (call): ChannelListV1Output => ({ channels: scope(call).channels }),
    'organisations.chatCommands.list@2': (call): ChatCommandListV2Output => ({ commands: scope(call).chatCommands }),
    // Every organisation has the standard commands; these worlds leave them as they come.
    'organisations.chatCommands.standard.list@1': (): StandardListV1Output => ({ commands: STANDARD_LISTED }),
    'organisations.subjects.states.list@2': (call): StateListV2Output => {
      const kind = call.query.get('kind');
      return { states: scope(call).states.filter(state => !kind || state.subjectId.startsWith(`${kind}:`)) };
    },
    'organisations.subjects.metrics.query@1': (call): MetricQueryV1Output => {
      const body = MetricQueryBodySchema.safeParse(call.body);
      if (!body.success) throw new ApiError(400, 'invalid_request', body.error.message);
      return queryMetrics(scope(call), body.data);
    },
    'organisations.topology.get@2': (call): TopologyGetV2Output => topologyOf(scope(call)),
    'organisations.status.get@1': (call): StatusGetV1Output => statusOf(scope(call)),
    'organisations.browser.ensure@1': unsimulated,
    'organisations.cameras.control.connect@1': unsimulated,
    'organisations.gateways.stats.connect@1': unsimulated,
    'organisations.streams.exposures.connect@2': unsimulated,
    'organisations.streams.connect@1': unsimulated,
    'organisations.outputs.previews.connect@2': unsimulated,
    'irohSessions.create@1': unsimulated,
    // Following a show is a WebSocket; versionless, so it has no version number.
    'organisations.shows.follow@0': unsimulated
  } satisfies Record<string, Projection>)
);
