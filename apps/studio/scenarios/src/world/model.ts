import type {
  AgentListV1Output,
  CameraListV2Output,
  ChatCommandListV2Output,
  ControlGetV1Output,
  DeviceListAddressesV1Output,
  DeviceListV2Output,
  GatewayListEndpointsV1Output,
  InvitationListMineV1Output,
  InvitationListV1Output,
  LiveListV1Output,
  MemberListV1Output,
  OrganisationListV1Output,
  OutputListV2Output,
  PersonalEnsureV1Params,
  ShowListV2Output,
  StreamListV2Output,
  TopologyGetV2Output
} from '@conservationtv/studio-sdk/versions';

import type { MemberFact } from '../../../api/src/shows/resolve.ts';
import type { WorldSpec } from './spec.ts';

// A world: one organisation as the studio API would hold it, in the contract's own shapes. Each list is what the API's
// current list operation returns, so projecting a response is selecting from here (older versions, such as the
// topology's, are made from these as the API makes them); the generated SDK's types keep the two matched, and a
// contract change that the generator doesn't follow fails typecheck.

type Topology = TopologyGetV2Output;

export type NetworkRow = Topology['networks'][number];
/** A device as the device list has it: the topology's, with the member a browser device belongs to. */
export type DeviceRow = DeviceListV2Output['devices'][number];
export type AgentRow = AgentListV1Output['agents'][number];
export type CameraRow = CameraListV2Output['cameras'][number];
/** What tells an organisation's own gateway from the built-in one: only its own has a certificate. */
interface WithCertificate {
  tls: unknown;
}
/** An organisation's own gateway; the built-in one is added where the API adds it. */
export type GatewayRow = Extract<Topology['gateways'][number], WithCertificate>;
/** A stream as the current stream list has it: its short code, and deliveries that name no rendition. */
export type StreamRow = StreamListV2Output['streams'][number];
/** A show as the current show list has it: its layout, its own mix and its takeover. */
export type ShowRow = ShowListV2Output['shows'][number];
/** One stream's membership of one show (`show_stream`): its rank in the lineup, and its channel in the show's mix. */
export type ShowStreamRow = MemberFact;
/** An output as the current output list has it, with the gateway it reads every stream from, if it names one. */
export type OutputRow = OutputListV2Output['outputs'][number];
export type ChannelRow = Topology['channels'][number];
export type StateRow = Topology['states'][number];
export type ChatCommandRow = ChatCommandListV2Output['commands'][number];
/** One of the organisation's deliveries, and whether its gateway says it is live now. */
export type LiveRow = LiveListV1Output['exposures'][number];

/** A member's own stream to go live on from a kind of device (`personal_stream`), made the first time they did. */
export interface PersonalStreamRow {
  userId: string;
  device: PersonalEnsureV1Params['device'];
  streamId: string;
}
export type MemberRow = MemberListV1Output['members'][number];
export type InvitationRow = InvitationListV1Output['invitations'][number];
export type MyInvitationRow = InvitationListMineV1Output['invitations'][number];
export type OrganisationListing = OrganisationListV1Output['organisations'][number];
export type AddressRow = DeviceListAddressesV1Output['addresses'][number];
export type EndpointRow = GatewayListEndpointsV1Output['endpoints'][number];
export type OutputControl = ControlGetV1Output;

export interface Viewer {
  id: string;
  name: string;
  email: string;
  createdAt: string;
}

/** A root cause the generator put into the world, in words, for the report: what the screenshots should show. */
export interface Incident {
  subjectId: string;
  summary: string;
}

export interface World {
  spec: WorldSpec;
  /** The moment the world is at: every time in it is relative to this, and the browser's clock is fixed to it. */
  now: string;
  viewer: Viewer;
  /** The organisations the account is in, the world's own first, with the account's roles in each. */
  organisations: OrganisationListing[];
  members: MemberRow[];
  invitations: InvitationRow[];
  myInvitations: MyInvitationRow[];
  networks: NetworkRow[];
  devices: DeviceRow[];
  agents: AgentRow[];
  cameras: CameraRow[];
  gateways: GatewayRow[];
  streams: StreamRow[];
  shows: ShowRow[];
  /** Each show's `show_stream` rows, by show ID, as its last sync left them: its lineup normalised. */
  showStreams: Record<string, ShowStreamRow[]>;
  /** The pushed streams the organisation shares (an encoder's, a keeper's phone), by ID: no camera feeds them. */
  sharedStreams: string[];
  personalStreams: PersonalStreamRow[];
  /** The deliveries someone is publishing to right now, by ID: each pushed stream's chain while it is live. */
  publishing: string[];
  outputs: OutputRow[];
  channels: ChannelRow[];
  chatCommands: ChatCommandRow[];
  states: StateRow[];
  addresses: Record<string, AddressRow[]>;
  endpoints: Record<string, EndpointRow[]>;
  outputControls: Record<string, OutputControl>;
  incidents: Incident[];
}

/** The world's own organisation, if the account is in any. */
export function focusOrganisation(world: World): OrganisationListing | undefined {
  return world.organisations[0];
}
