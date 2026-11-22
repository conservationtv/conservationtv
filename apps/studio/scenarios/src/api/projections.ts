import {
  MetricQueryV1ParamsSchema,
  type AccountGetV1Output,
  type AgentListV1Output,
  type CameraListV2Output,
  type ChannelListV1Output,
  type ChatCommandListV1Output,
  type ControlGetV1Output,
  type DeviceListAddressesV1Output,
  type DeviceListV2Output,
  type GatewayListEndpointsV1Output,
  type GatewayListV1Output,
  type InvitationGetV1Output,
  type InvitationListMineV1Output,
  type InvitationListV1Output,
  type MemberListV1Output,
  type MetricQueryV1Output,
  type NetworkListV1Output,
  type OrganisationGetV1Output,
  type OrganisationListV1Output,
  type OutputListV1Output,
  type ShowListV1Output,
  type StateListV2Output,
  type StatusGetV1Output,
  type StreamListV1Output,
  type TopologyGetV2Output
} from '@conservationtv/studio-sdk/versions';
import type { JSONValue } from 'hono/utils/types';

// The API's own status rule, so the status the UI shows is the one the API would work out from these states. It is
// pure (it reads only the lists it is given), and imported from the API's source because the API doesn't export it.
import { organisationStatus } from '../../../api/src/health/status.ts';
import { BUILTIN_GATEWAY_ID } from '../world/generate.ts';
import { queryMetrics } from '../world/metrics.ts';
import type { World } from '../world/model.ts';

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
  | ChatCommandListV1Output
  | ControlGetV1Output
  | DeviceListAddressesV1Output
  | DeviceListV2Output
  | GatewayListEndpointsV1Output
  | GatewayListV1Output
  | InvitationGetV1Output
  | InvitationListMineV1Output
  | InvitationListV1Output
  | MemberListV1Output
  | MetricQueryV1Output
  | NetworkListV1Output
  | OrganisationGetV1Output
  | OrganisationListV1Output
  | OutputListV1Output
  | ShowListV1Output
  | StateListV2Output
  | StatusGetV1Output
  | StreamListV1Output
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

/** The organisation's status, by the API's own rule. */
export function statusOf(world: World): StatusGetV1Output {
  return organisationStatus({
    devices: world.devices,
    cameras: world.cameras,
    agents: world.agents,
    gateways: [BUILTIN_GATEWAY, ...world.gateways],
    streams: world.streams,
    shows: world.shows,
    outputs: world.outputs,
    channels: world.channels,
    states: world.states.map(state => ({ ...state, observedAt: new Date(state.observedAt) }))
  });
}

function topologyOf(world: World): TopologyGetV2Output {
  return {
    shows: world.shows,
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
    streams: world.streams,
    outputs: world.outputs,
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
    'organisations.streams.list@1': (call): StreamListV1Output => ({ streams: scope(call).streams }),
    'organisations.shows.list@1': (call): ShowListV1Output => ({
      // What a show places is the topology's to say, not the show list's.
      shows: scope(call).shows.map(({ name, id, createdAt, outputs }) => ({ name, id, createdAt, outputs }))
    }),
    'organisations.outputs.list@1': (call): OutputListV1Output => ({ outputs: scope(call).outputs }),
    'organisations.outputs.control.get@1': (call): ControlGetV1Output => {
      const world = scope(call);
      const control = world.outputControls[call.params.outputId ?? ''];
      if (!control) throw notFound('control report');
      return control;
    },
    'organisations.channels.list@1': (call): ChannelListV1Output => ({ channels: scope(call).channels }),
    'organisations.chatCommands.list@1': (call): ChatCommandListV1Output => ({ commands: scope(call).chatCommands }),
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
    'organisations.streams.exposures.connect@1': unsimulated,
    'organisations.outputs.previews.connect@1': unsimulated,
    'irohSessions.create@1': unsimulated,
    // Following a show is a WebSocket; versionless, so it has no version number.
    'organisations.shows.follow@0': unsimulated
  } satisfies Record<string, Projection>)
);
