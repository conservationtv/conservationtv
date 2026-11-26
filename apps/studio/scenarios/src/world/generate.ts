import { normalised, positionedOf, stateOf } from '../../../api/src/shows/resolve.ts';
import { assignHealth } from './health.ts';
import type {
  AddressRow,
  AgentRow,
  CameraRow,
  ChannelRow,
  ChatCommandRow,
  DeviceRow,
  EndpointRow,
  GatewayRow,
  InvitationRow,
  MemberRow,
  MyInvitationRow,
  NetworkRow,
  OrganisationListing,
  OutputControl,
  OutputRow,
  PersonalStreamRow,
  ShowRow,
  ShowStreamRow,
  StreamRow,
  Viewer,
  World
} from './model.ts';
import { Namer } from './names.ts';
import { Rng } from './rng.ts';
import { showFactsOf, type ShowSources } from './shows.ts';
import type { WorldSpec } from './spec.ts';

// A world from its spec: an organisation built the way people build one (networks, then the agents and cameras on
// them, then streams of those cameras delivered through gateways, shows lining them up, streams people publish to,
// outputs going out to channels), with whatever gaps the spec asks for, then health over the top (src/world/health.ts).

/** Where every world is in time. Fixed, so relative times ("3 minutes ago") and timestamps render the same each run. */
export const WORLD_NOW = new Date('2026-06-01T10:30:00.000Z');

/** The built-in gateway every organisation has (apps/studio/api/src/gateways/conservationtv.ts). */
export const BUILTIN_GATEWAY_ID = 'conservationtv';

const DAY_MS = 86_400_000;

export const MEMBER_ROLE = { id: '@shared/organisationMember', label: 'Member' };
export const ADMINISTRATOR_ROLE = { id: '@shared/organisationAdmin', label: 'Administrator' };
/** Granted on its own to a member who may go live; administrators hold it as part of their role, unlisted. */
export const PUBLISHER_ROLE = { id: '@shared/streamPublisher', label: 'Publisher' };

/** A time `minDays`–`maxDays` before the world's now. */
function daysAgo(rng: Rng, minDays: number, maxDays: number): Date {
  return new Date(WORLD_NOW.getTime() - Math.round((minDays + rng.float() * (maxDays - minDays)) * DAY_MS));
}

/** A time after `start`, before the world's now. */
function after(rng: Rng, start: Date): Date {
  const span = WORLD_NOW.getTime() - start.getTime();
  return new Date(start.getTime() + Math.round(span * (0.05 + rng.float() * 0.9)));
}

/** Anything with an ID. */
interface Identified {
  id: string;
}

function byId<T extends Identified>(rows: T[]): T[] {
  return rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function lanAddress(rng: Rng, subnet: number): string {
  return `192.168.${subnet}.${rng.int(10, 250)}`;
}

/** A network's cameras and gateways, for the streams built on them. */
interface Site {
  network: NetworkRow;
  cameras: CameraRow[];
  gateways: GatewayRow[];
}

/** An organisation as it is built up: what is generated from, and the lists made so far. */
interface Build {
  spec: WorldSpec;
  root: Rng;
  names: Namer;
  now: string;
  organisation: OrganisationListing;
  orgCreated: Date;
  devices: DeviceRow[];
  agents: AgentRow[];
  cameras: CameraRow[];
  gateways: GatewayRow[];
  networks: NetworkRow[];
  addresses: Record<string, AddressRow[]>;
  endpoints: Record<string, EndpointRow[]>;
  sites: Site[];
}

/** A device, as the device list has it, added to the build. */
function addDevice(
  build: Build,
  rng: Rng,
  kind: DeviceRow['kind'],
  name: string,
  networkId: string | null,
  created: Date
) {
  const row: DeviceRow = {
    id: rng.uuid(created),
    kind,
    name,
    networkId,
    publicKey: rng.base64url(32),
    publicId: rng.hex(32),
    createdAt: created.toISOString(),
    userId: null,
    memberName: null
  };
  build.devices.push(row);
  return row;
}

/** A device as an agent or camera embeds it: the device row without its ID or member. */
function embedded(row: DeviceRow) {
  return {
    name: row.name,
    createdAt: row.createdAt,
    publicKey: row.publicKey,
    kind: row.kind,
    networkId: row.networkId,
    publicId: row.publicId
  };
}

function viewerOf(root: Rng, names: Namer): Viewer {
  const viewerRng = root.child('viewer');
  const viewerCreated = daysAgo(viewerRng, 300, 500);
  const viewerPerson = names.person(0);
  return {
    id: viewerRng.uuid(viewerCreated),
    name: viewerPerson.name,
    email: viewerPerson.email,
    createdAt: viewerCreated.toISOString()
  };
}

/** The roles the account holds in its own organisation, as the spec says. */
function viewerRoles(spec: WorldSpec): OrganisationListing['roles'] {
  if (spec.viewer === 'admin') return [MEMBER_ROLE, ADMINISTRATOR_ROLE];
  return spec.viewer === 'publisher' ? [MEMBER_ROLE, PUBLISHER_ROLE] : [MEMBER_ROLE];
}

/** The organisations the account is in: its roles in the first as the spec says, administering the others by chance. */
function organisationsOf(spec: WorldSpec, root: Rng, names: Namer): OrganisationListing[] {
  const organisations: OrganisationListing[] = [];
  for (let index = 0; index < spec.organisations; index++) {
    const rng = root.child('organisation', index);
    const created = daysAgo(rng, 200, 400);
    const admin = index === 0 ? false : rng.chance(0.5);
    organisations.push({
      id: rng.uuid(created),
      name: names.organisation(index),
      createdAt: created.toISOString(),
      roles: index === 0 ? viewerRoles(spec) : admin ? [MEMBER_ROLE, ADMINISTRATOR_ROLE] : [MEMBER_ROLE]
    });
  }
  return organisations;
}

/** Invitations waiting for the account, to organisations it isn't in. */
function myInvitationsOf(spec: WorldSpec, root: Rng, names: Namer): MyInvitationRow[] {
  const myInvitations: MyInvitationRow[] = [];
  for (let index = 0; index < spec.myInvitations; index++) {
    const rng = root.child('my-invitation', index);
    const created = daysAgo(rng, 1, 6);
    myInvitations.push({
      id: rng.uuid(created),
      organisation: { id: rng.child('organisation').uuid(daysAgo(rng, 100, 300)), name: names.organisation(index + 2) },
      expiresAt: new Date(created.getTime() + 7 * DAY_MS).toISOString()
    });
  }
  return myInvitations;
}

/**
 * The account first, as a founding member, then the others; a few administer it, some of the rest may go live, and a
 * few have no display name.
 */
function membersOf(build: Build, viewer: Viewer): MemberRow[] {
  const members: MemberRow[] = [
    {
      userId: viewer.id,
      displayName: viewer.name,
      joinedAt: build.orgCreated.toISOString(),
      roles: build.organisation.roles
    }
  ];
  for (let index = 0; index < build.spec.members; index++) {
    const rng = build.root.child('member', index);
    const joined = after(rng, build.orgCreated);
    const person = build.names.person(index + 1);
    const userId = rng.uuid(joined);
    const displayName = rng.chance(0.9) ? person.name : null;
    const admin = rng.chance(0.25);
    const publisher = rng.child('publisher').chance(build.spec.operating.publishers);
    members.push({
      userId,
      displayName,
      joinedAt: joined.toISOString(),
      roles: admin ? [MEMBER_ROLE, ADMINISTRATOR_ROLE] : publisher ? [MEMBER_ROLE, PUBLISHER_ROLE] : [MEMBER_ROLE]
    });
  }
  return members;
}

function invitationsOf(build: Build, viewer: Viewer): InvitationRow[] {
  const invitations: InvitationRow[] = [];
  for (let index = 0; index < build.spec.invitations; index++) {
    const rng = build.root.child('invitation', index);
    const created = daysAgo(rng, 0.2, 6);
    invitations.push({
      id: rng.uuid(created),
      email: build.names.person(index + build.spec.members + 1).email,
      userId: null,
      invitedBy: viewer.id,
      createdAt: created.toISOString(),
      expiresAt: new Date(created.getTime() + 7 * DAY_MS).toISOString()
    });
  }
  return invitations;
}

/** An agent's addresses: on the site's LAN, and sometimes on a tailnet too. */
function agentAddresses(build: Build, agentRng: Rng, subnet: number): AddressRow[] {
  const lan: AddressRow = {
    address: lanAddress(agentRng, subnet),
    interface: 'eth0',
    preferred: true,
    reportedAt: build.now
  };
  if (!agentRng.chance(0.4)) return [lan];
  const tailnet = `100.${agentRng.int(64, 127)}.${agentRng.int(0, 255)}.${agentRng.int(1, 254)}`;
  return [lan, { address: tailnet, interface: 'tailscale0', preferred: false, reportedAt: build.now }];
}

/** A network's agents: the first is its active one, unless the network has none. */
function addAgents(build: Build, network: NetworkRow, rng: Rng, created: Date, subnet: number) {
  const agentCount = rng.child('agents').range(build.spec.agentsPerNetwork);
  const leaderless = rng.child('leaderless').chance(build.spec.gaps.networkWithoutActiveAgent);
  for (let a = 0; a < agentCount; a++) {
    const agentRng = rng.child('agent', a);
    const row = addDevice(
      build,
      agentRng,
      'agent',
      build.names.agent(network.name, a),
      network.id,
      after(agentRng, created)
    );
    const active = a === 0 && !leaderless;
    build.agents.push({ id: row.id, active, networkId: network.id, priority: a, device: embedded(row) });
    if (active) network.activeAgent = { id: row.id };
    build.addresses[row.id] = agentAddresses(build, agentRng, subnet);
  }
}

/** A camera's state: switched off, locked, or enabled, by the spec's gaps. */
function cameraState(build: Build, cameraRng: Rng): CameraRow['state'] {
  if (cameraRng.child('disabled').chance(build.spec.gaps.cameraDisabled)) return 'disabled';
  if (cameraRng.child('locked').chance(build.spec.gaps.cameraLocked)) return 'locked';
  return 'enabled';
}

/** An Axis camera's presets; a plain RTSP camera can't move, so it has none. */
function presetsOf(build: Build, cameraRng: Rng, row: DeviceRow, axis: boolean): CameraRow['presets'] {
  const presets: CameraRow['presets'] = [];
  const presetCount = axis ? cameraRng.child('presets').range(build.spec.presetsPerCamera) : 0;
  for (let p = 0; p < presetCount; p++) {
    const presetRng = cameraRng.child('preset', p);
    const presetCreated = after(presetRng, new Date(row.createdAt));
    presets.push({
      id: presetRng.uuid(presetCreated),
      name: build.names.preset(p),
      createdAt: presetCreated.toISOString(),
      position: { pan: presetRng.int(-180, 180), tilt: presetRng.int(-90, 0), zoom: presetRng.int(1, 9999) },
      thumbnail: null
    });
  }
  return byId(presets);
}

/** A camera on a network: mostly Axis, some plain RTSP. */
function addCamera(
  build: Build,
  network: NetworkRow,
  cameraRng: Rng,
  created: Date,
  nameIndex: number,
  subnet: number
) {
  const row = addDevice(
    build,
    cameraRng,
    'camera',
    build.names.camera(nameIndex),
    network.id,
    after(cameraRng, created)
  );
  const host = lanAddress(cameraRng, subnet);
  const state = cameraState(build, cameraRng);
  const axis = cameraRng.chance(0.75);
  const presets = presetsOf(build, cameraRng, row, axis);
  const camera: CameraRow = {
    id: row.id,
    settings: axis
      ? { driver: 'axis', host, resolutions: ['1920x1080', '1280x720', '640x360'] }
      : { driver: 'rtsp', url: `rtsp://${host}:554/stream1` },
    state,
    aliases: cameraRng.chance(0.3) ? [row.name.split(' ')[0]?.toLowerCase() ?? 'cam'] : [],
    device: embedded(row),
    presets
  };
  build.cameras.push(camera);
  build.addresses[row.id] = [{ address: host, interface: 'eth0', preferred: true, reportedAt: build.now }];
  return camera;
}

/** The URL a gateway's endpoint for a protocol registers, behind its certificate's hostname. */
function endpointUrl(hostname: string, protocol: string): string {
  if (protocol === 'rtsp') return `rtsps://${hostname}:8322`;
  return `https://${hostname}:${protocol === 'hls' ? 8888 : 8889}`;
}

/** The TLS a gateway has: a certificate, or an error from trying to issue one. */
function tlsOf(build: Build, gatewayRng: Rng, gatewayCreated: Date, hostname: string, host: string): GatewayRow['tls'] {
  const tlsError = gatewayRng.child('tls').chance(build.spec.gaps.gatewayTlsError);
  return {
    hostname,
    address: host,
    issuedAt: tlsError ? null : after(gatewayRng, gatewayCreated).toISOString(),
    notAfter: tlsError ? null : new Date(WORLD_NOW.getTime() + 60 * DAY_MS).toISOString(),
    attemptedAt: build.now,
    error: tlsError ? 'DNS challenge failed: no TXT record found for _acme-challenge' : null
  };
}

/** One of the organisation's own MediaMTX gateways on a network, with the endpoints its active agent registers. */
function addGateway(build: Build, network: NetworkRow, gatewayRng: Rng, index: number, created: Date, subnet: number) {
  const gatewayCreated = after(gatewayRng, created);
  const host = lanAddress(gatewayRng, subnet);
  const hostname = `${gatewayRng.hex(4)}.gateways.conservation.tv`;
  const id = gatewayRng.uuid(gatewayCreated);
  const gateway: GatewayRow = {
    id,
    builtin: false,
    name: build.names.gateway(network.name, index),
    kind: 'mediamtx',
    networkId: network.id,
    settings: { urls: { rtsp: `rtsp://${host}:8554`, webrtc: `http://${host}:8889`, hls: `http://${host}:8888` } },
    createdAt: gatewayCreated.toISOString(),
    tls: tlsOf(build, gatewayRng, gatewayCreated, hostname, host)
  };
  build.gateways.push(gateway);
  const activeAgent = network.activeAgent;
  if (activeAgent) {
    build.endpoints[gateway.id] = ['rtsp', 'webrtc', 'hls'].map(protocol => ({
      protocol,
      url: endpointUrl(hostname, protocol),
      deviceId: activeAgent.id,
      registeredAt: new Date(WORLD_NOW.getTime() - 5 * 60_000).toISOString(),
      expiresAt: new Date(WORLD_NOW.getTime() + 25 * 60_000).toISOString()
    }));
  }
  return gateway;
}

/** A network, its agents, cameras and gateways. */
function addSite(build: Build, n: number) {
  const rng = build.root.child('network', n);
  const created = after(rng, build.orgCreated);
  const network: NetworkRow = {
    id: rng.uuid(created),
    name: build.names.network(n),
    createdAt: created.toISOString(),
    activeAgent: null
  };
  build.networks.push(network);
  const subnet = 10 + n;
  addAgents(build, network, rng, created, subnet);
  const cameraCount = rng.child('cameras').range(build.spec.camerasPerNetwork);
  const cameras: CameraRow[] = [];
  for (let c = 0; c < cameraCount; c++)
    cameras.push(addCamera(build, network, rng.child('camera', c), created, n * 100 + c, subnet));
  const gatewayCount = rng.child('gateways').range(build.spec.gatewaysPerNetwork);
  const gateways: GatewayRow[] = [];
  for (let g = 0; g < gatewayCount; g++)
    gateways.push(addGateway(build, network, rng.child('gateway', g), g, created, subnet));
  build.sites.push({ network, cameras, gateways });
}

/**
 * A stream's deliveries: first through a gateway on its network when it has one, then on to the built-in relay, unless
 * it is delivered only on its site (`siteOnly`, with a gateway there to deliver it).
 */
function deliveriesOf(rng: Rng, created: Date, siteGateways: GatewayRow[], siteOnly: boolean): StreamRow['exposures'] {
  const exposures: StreamRow['exposures'] = [];
  const local = siteGateways.length ? rng.pick(siteGateways) : undefined;
  let upstream: string | null = null;
  if (local) {
    const exposureCreated = after(rng.child('local'), created);
    upstream = rng.child('local').uuid(exposureCreated);
    exposures.push({
      params: {},
      id: upstream,
      createdAt: exposureCreated.toISOString(),
      gatewayId: local.id,
      publisherDeviceId: null,
      upstreamExposureId: null
    });
  }
  // Drawn and thrown away: this once chose whether the relay's delivery also offered a smaller rendition, and the
  // stream's ID is drawn from this sequence after it, so keeping the draw keeps every stream's ID as it was.
  rng.float();
  if (local && siteOnly) return exposures;
  const relayCreated = after(rng.child('relay'), created);
  exposures.push({
    params: {},
    id: rng.child('relay').uuid(relayCreated),
    createdAt: relayCreated.toISOString(),
    gatewayId: BUILTIN_GATEWAY_ID,
    publisherDeviceId: null,
    upstreamExposureId: upstream
  });
  return exposures;
}

/** A stream, its deliveries, and sometimes a recorder of its first delivery. */
function streamOf(
  build: Build,
  rng: Rng,
  name: string,
  source: CameraRow | null,
  siteGateways: GatewayRow[],
  siteOnly = false
): StreamRow {
  const created = after(rng, source ? new Date(source.device?.createdAt ?? build.orgCreated) : build.orgCreated);
  const exposures = deliveriesOf(rng, created, siteGateways, siteOnly);
  const recorders: StreamRow['recorders'] = [];
  const first = exposures[0];
  if (first && rng.child('recorder').chance(0.2)) {
    const recorderCreated = after(rng.child('recorder'), created);
    recorders.push({
      params: {},
      id: rng.child('recorder').uuid(recorderCreated),
      createdAt: recorderCreated.toISOString(),
      kind: 'mp4-segments',
      exposureId: first.id
    });
  }
  // Its code, if it has one, is given once every stream is made (`withCodes`).
  return {
    code: null,
    name,
    id: rng.uuid(created),
    createdAt: created.toISOString(),
    sourceDeviceId: source?.id ?? null,
    exposures: byId(exposures),
    recorders
  };
}

/** Each camera's streams; some have no source at all, and a world that asks for those always has one. */
function streamsOf(build: Build): StreamRow[] {
  const streams: StreamRow[] = [];
  for (const site of build.sites) {
    // Through the site's own gateways, when it has any.
    for (const camera of site.cameras) {
      // Keyed by camera, so a camera's streams stay the same whatever is generated around it.
      const rng = build.root.child('streams', camera.id);
      const count = rng.range(build.spec.streamsPerCamera);
      for (let s = 0; s < count; s++) {
        // Named after its camera, even when the spec's gaps leave it without one.
        const streamRng = rng.child(s);
        const orphan = streamRng.child('orphan').chance(build.spec.gaps.streamWithoutSource);
        const siteOnly = !orphan && streamRng.child('site-only').chance(build.spec.operating.siteOnlyStreams);
        const name = build.names.stream(camera.device?.name ?? 'Camera', s);
        streams.push(streamOf(build, streamRng, name, orphan ? null : camera, site.gateways, siteOnly));
      }
    }
  }
  if (build.spec.gaps.streamWithoutSource > 0 && streams.length === 0) {
    streams.push(streamOf(build, build.root.child('streams', 'orphan'), 'Unassigned stream', null, []));
  }
  return streams;
}

/** The organisation's shows, and each one's `show_stream` rows by show ID. */
interface Shows {
  shows: ShowRow[];
  showStreams: Record<string, ShowStreamRow[]>;
}

/** How a stream is mixed in a show it has never been given settings in: standard volume, unmuted, its own sound. */
const STANDARD_MIX = { volumeDb: 0, muted: false, syncOffsetMs: 0, audioStreamId: null } as const;

/**
 * A show's slot count: none when left uncomposed, the spec's when it names a range, else as many as the cameras it was
 * set up with; a show made where nothing is delivered yet keeps the default layout (six), every slot empty.
 */
function slotsOf(build: Build, rng: Rng, leftUncomposed: boolean, setUpWith: number): number {
  if (leftUncomposed) return 0;
  if (build.spec.slotsPerShow) return Math.min(6, Math.max(0, rng.child('slots').range(build.spec.slotsPerShow)));
  return setUpWith === 0 ? 6 : setUpWith;
}

/**
 * Each show's lineup, as the API keeps it in `show_stream`: the cameras it was set up with first, in that order, then
 * every other camera stream oldest first, as normalising leaves them (src/shows/resolve.ts). The cameras it was set up
 * with are drawn as shows once placed deliveries were, so a show places what it did (and its ID is as it was).
 */
function showsOf(build: Build, streams: StreamRow[]): Shows {
  // One draw per delivered stream: once each stream's delivery on the relay, which every stream then had.
  const delivered = streams.filter(stream => stream.exposures.length > 0);
  const shows: ShowRow[] = [];
  const showStreams: Record<string, ShowStreamRow[]> = {};
  for (let s = 0; s < build.spec.shows; s++) {
    const rng = build.root.child('show', s);
    const created = after(rng, build.orgCreated);
    const leftUncomposed = rng.child('uncomposed').chance(build.spec.gaps.showUncomposed);
    const setUpWith =
      leftUncomposed || delivered.length === 0
        ? []
        : rng.child('placed').sample(delivered, rng.int(1, Math.min(4, delivered.length)));
    const show: ShowRow = {
      name: build.names.show(s),
      id: rng.uuid(created),
      createdAt: created.toISOString(),
      slots: slotsOf(build, rng, leftUncomposed, setUpWith.length),
      volumeDb: 0,
      muted: false,
      takeoverStreamId: null,
      takeoverLive: false,
      outputs: []
    };
    // Ranked in the order it was set up with, its cameras' streams (a locked one keeping its place); normalising ranks
    // any new camera after them.
    const sources = { organisationId: build.organisation.id, streams, cameras: build.cameras, showStreams, states: [] };
    const inLineup = setUpWith.filter(stream => stateOf(stream, { cameras: build.cameras, states: [] }) !== undefined);
    showStreams[show.id] = inLineup.map((stream, index) => ({ ...STANDARD_MIX, streamId: stream.id, rank: index + 1 }));
    showStreams[show.id] = normalised(showFactsOf(sources, show)).members;
    shows.push(show);
  }
  return { shows, showStreams };
}

/** Whether a member may go live: given the right on its own, or as an administrator. */
function mayPublish(member: MemberRow): boolean {
  return member.roles.some(role => role.id === PUBLISHER_ROLE.id || role.id === ADMINISTRATOR_ROLE.id);
}

/**
 * What a stream made for someone to go live on is called, as the API names it ("Ada’s phone"): `personalName` in
 * apps/studio/api/src/services/publishing.ts, which isn't exported, and sits among database code.
 */
function personalName(displayName: string | null, device: PersonalStreamRow['device']): string {
  const whose = displayName === null || displayName.trim() === '' ? 'My' : `${displayName.trim()}’s`;
  return `${whose} ${device}`.slice(0, 120);
}

/**
 * A pushed stream's deliveries, as publishing it the first time made them (docs/shows.md, The chain), kept whether or
 * not anyone publishes now: straight to the relay, as a browser publishes by MoQ; or, by `throughGateway`'s chance,
 * into one of the organisation's gateways (RTMP from an encoder, WHIP from a browser), with an onward hop to the relay
 * that the gateway's agent republishes it to.
 */
function pushedDeliveriesOf(build: Build, rng: Rng, created: Date, throughGateway: number): StreamRow['exposures'] {
  const exposures: StreamRow['exposures'] = [];
  const ingestAt =
    build.gateways.length && rng.child('route').chance(throughGateway)
      ? rng.child('gateway').pick(build.gateways)
      : undefined;
  let upstream: string | null = null;
  let relayAfter = created;
  if (ingestAt) {
    relayAfter = after(rng.child('ingest'), created);
    upstream = rng.child('ingest').uuid(relayAfter);
    exposures.push({
      params: {},
      id: upstream,
      createdAt: relayAfter.toISOString(),
      gatewayId: ingestAt.id,
      publisherDeviceId: null,
      upstreamExposureId: null
    });
  }
  const relayCreated = after(rng.child('relay'), relayAfter);
  exposures.push({
    params: {},
    id: rng.child('relay').uuid(relayCreated),
    createdAt: relayCreated.toISOString(),
    gatewayId: BUILTIN_GATEWAY_ID,
    publisherDeviceId: null,
    upstreamExposureId: upstream
  });
  return byId(exposures);
}

/** A stream no camera feeds, made at `created`, with the deliveries publishing it made. */
function pushedStreamOf(build: Build, rng: Rng, name: string, created: Date, throughGateway: number): StreamRow {
  return {
    code: null,
    name,
    id: rng.uuid(created),
    createdAt: created.toISOString(),
    sourceDeviceId: null,
    exposures: pushedDeliveriesOf(build, rng, created, throughGateway),
    recorders: []
  };
}

/** The organisation's pushed streams: those it shares, and those members made going live, and whose each is. */
interface Pushed {
  streams: StreamRow[];
  sharedStreams: string[];
  personalStreams: PersonalStreamRow[];
}

/**
 * Pushed streams: the spec's shared ones (mostly an encoder's, into a gateway), and each one someone who may publish
 * made by going live from a phone or a computer (mostly by MoQ, straight to the relay), keyed by who and which device.
 */
function pushedStreamsOf(build: Build, members: MemberRow[]): Pushed {
  const streams: StreamRow[] = [];
  const sharedStreams: string[] = [];
  for (let p = 0; p < build.spec.pushedStreams; p++) {
    const rng = build.root.child('pushed-stream', p);
    const stream = pushedStreamOf(build, rng, build.names.pushed(p), after(rng, build.orgCreated), 0.7);
    streams.push(stream);
    sharedStreams.push(stream.id);
  }
  const personalStreams: PersonalStreamRow[] = [];
  for (const member of members.filter(mayPublish)) {
    const rng = build.root.child('personal-stream', member.userId);
    if (!rng.chance(build.spec.operating.personalStreams)) continue;
    const first = rng.child('device').pick(['phone', 'computer'] as const);
    const devices = rng.child('both').chance(0.2) ? (['phone', 'computer'] as const) : [first];
    for (const device of devices) {
      const deviceRng = rng.child(device);
      const name = personalName(member.displayName, device);
      const stream = pushedStreamOf(build, deviceRng, name, after(deviceRng, new Date(member.joinedAt)), 0.2);
      streams.push(stream);
      personalStreams.push({ userId: member.userId, device, streamId: stream.id });
    }
  }
  return { streams, sharedStreams, personalStreams };
}

/**
 * A short code from a stream's name, as someone would choose one for chat: its first word when that is short, else
 * the word's first three letters, numbered when another stream has it (1–4 of `A-Z0-9`, unique in the organisation).
 */
function codeOf(name: string, taken: ReadonlySet<string>): string {
  const words = name
    .normalize('NFKD')
    .toUpperCase()
    .split(/\s+/u)
    .map(word => word.replace(/[^A-Z0-9]/gu, ''));
  const word = words.find(candidate => candidate !== '') ?? 'S';
  const base = word.length <= 4 ? word : word.slice(0, 3);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base.slice(0, 4 - String(n).length)}${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** The streams, some given a code by the spec's chance, each keyed by its stream: the oldest has first pick. */
function withCodes(build: Build, streams: StreamRow[]): StreamRow[] {
  const taken = new Set<string>();
  for (const stream of byId([...streams])) {
    if (!build.root.child('stream-code', stream.id).chance(build.spec.operating.streamCodes)) continue;
    stream.code = codeOf(stream.name, taken);
    taken.add(stream.code);
  }
  return streams;
}

/** The deliveries someone is publishing to now: each pushed stream's whole chain, by the spec's chance. */
function publishingOf(build: Build, pushed: StreamRow[]): string[] {
  return pushed
    .filter(stream => build.root.child('pushed-live', stream.id).chance(build.spec.operating.pushedLive))
    .flatMap(stream => stream.exposures.map(exposure => exposure.id));
}

/** A level someone set, or standard volume. */
function levelOf(rng: Rng, chance: number, levels: readonly number[]): number {
  return rng.chance(chance) ? rng.pick(levels) : 0;
}

/**
 * How a show is operated, keyed by the show: its own mix, each stream on screen's channel (its sound sometimes taken
 * from another on screen, so it places nothing more), and the stream armed to take over, if any: one live now, else
 * any pushed stream, else a camera on screen ("solo").
 */
function operateShow(build: Build, s: number, show: ShowRow, sources: ShowSources, pushed: Pushed, live: Set<string>) {
  const rng = build.root.child('show', s);
  show.volumeDb = levelOf(rng.child('show-mix'), 0.15, [-6, -3]);
  const facts = normalised(showFactsOf(sources, show));
  const onScreen = positionedOf(facts)
    .slice(0, show.slots)
    .map(stream => stream.id);
  sources.showStreams[show.id] = facts.members.map(member => {
    if (!onScreen.includes(member.streamId)) return member;
    const mixRng = rng.child('mix', member.streamId);
    const others = onScreen.filter(streamId => streamId !== member.streamId);
    const from = mixRng.child('from');
    return {
      ...member,
      volumeDb: levelOf(mixRng.child('volume'), 0.2, [-12, -6, -3, 3]),
      muted: mixRng.child('muted').chance(0.1),
      syncOffsetMs: levelOf(mixRng.child('sync'), 0.1, [-200, 120, 450]),
      audioStreamId: others.length && from.chance(0.05) ? from.pick(others) : null
    };
  });
  const takeover = rng.child('takeover');
  if (!takeover.chance(build.spec.operating.takeoverArmed)) return;
  const livePushed = pushed.streams.filter(stream => stream.exposures.some(exposure => live.has(exposure.id)));
  const candidates = livePushed.length
    ? livePushed.map(stream => stream.id)
    : pushed.streams.length
      ? pushed.streams.map(stream => stream.id)
      : onScreen;
  if (candidates.length === 0) return;
  show.takeoverStreamId = takeover.child('stream').pick(candidates);
  show.takeoverLive = takeover.child('live').chance(build.spec.operating.takeoverLive);
}

/** Channels: the first on Twitch, the rest mostly so, the others RTMP destinations. */
function channelsOf(build: Build): ChannelRow[] {
  const channels: ChannelRow[] = [];
  for (let c = 0; c < build.spec.channels; c++) {
    const rng = build.root.child('channel', c);
    const created = after(rng, build.orgCreated);
    const kind = c === 0 || rng.chance(0.6) ? 'twitch' : 'rtmp';
    const named = build.names.channel(c, kind);
    channels.push({
      id: rng.uuid(created),
      kind,
      name: named.name,
      externalId: kind === 'twitch' ? String(rng.int(10_000_000, 999_999_999)) : null,
      externalLogin: named.login,
      createdAt: created.toISOString()
    });
  }
  return channels;
}

/** An output's forwards: to one or two channels, some switched off. */
function forwardsOf(build: Build, rng: Rng, created: Date, channels: ChannelRow[]): OutputRow['forwards'] {
  const forwardCount = channels.length ? rng.child('forwards').int(1, Math.min(2, channels.length)) : 0;
  const forwards = rng
    .child('forward-channels')
    .sample(channels, forwardCount)
    .map((channel, f) => {
      const forwardRng = rng.child('forward', f);
      const forwardCreated = after(forwardRng, created);
      return {
        id: forwardRng.uuid(forwardCreated),
        createdAt: forwardCreated.toISOString(),
        enabled: !forwardRng.child('disabled').chance(build.spec.gaps.forwardDisabled),
        channelId: channel.id
      };
    });
  return byId(forwards);
}

/** Twitch channels whose chat controls the output though it doesn't go out to them: now and then, one. */
function controlChannelsOf(
  rng: Rng,
  created: Date,
  channels: ChannelRow[],
  forwards: OutputRow['forwards']
): OutputRow['controlChannels'] {
  const draw = rng.child('control-channels');
  const forwarded = new Set(forwards.map(forward => forward.channelId));
  const candidates = channels.filter(
    channel => channel.kind === 'twitch' && channel.externalLogin !== null && !forwarded.has(channel.id)
  );
  if (candidates.length === 0 || !draw.chance(0.4)) return [];
  const channel = draw.pick(candidates);
  return [{ channelId: channel.id, createdAt: after(draw.child('at'), created).toISOString() }];
}

/** What an output is attached to: the show it follows (none when driven from outside) and the agent running it. */
interface OutputPlacement {
  show: ShowRow | undefined;
  deviceId: string | null;
}

/** Driven from outside when there's no show to follow or by the spec's chance; on no agent when there's none to run it. */
function placementOf(build: Build, rng: Rng, o: number, shows: ShowRow[]): OutputPlacement {
  const external = shows.length === 0 || rng.child('external').chance(build.spec.externalOutputs);
  const agentDevices = build.agents.map(agent => agent.id);
  const deviceless = agentDevices.length === 0 || rng.child('deviceless').chance(build.spec.gaps.outputWithoutDevice);
  return {
    show: external ? undefined : shows[o % shows.length],
    deviceId: deviceless ? null : rng.child('device').pick(agentDevices)
  };
}

/** An output's OBS recorder, when it records. */
function outputRecordersOf(rng: Rng, created: Date): OutputRow['recorders'] {
  const recorderCreated = after(rng.child('recorder'), created);
  if (!rng.child('recorder').chance(0.4)) return [];
  return [
    {
      params: {},
      id: rng.child('recorder').uuid(recorderCreated),
      createdAt: recorderCreated.toISOString(),
      kind: 'obs'
    }
  ];
}

/** An output's preview on the relay, when it has one. */
function previewsOf(rng: Rng, created: Date): OutputRow['previews'] {
  const previewCreated = after(rng.child('preview'), created);
  if (!rng.child('preview').chance(0.6)) return [];
  return [
    {
      id: rng.child('preview').uuid(previewCreated),
      createdAt: previewCreated.toISOString(),
      gatewayId: BUILTIN_GATEWAY_ID
    }
  ];
}

/** What OBS on an output's agent last reported of how to control it. */
function controlOf(build: Build, rng: Rng, id: string, deviceId: string): OutputControl {
  return {
    deviceId,
    websocketPort: 4455,
    websocketPassword: rng.child('control').base64url(12),
    sceneCollection: `ctv-${id.slice(-8)}`,
    inputUrl: `moq://relay.conservation.tv/${build.organisation.id}/${id}`,
    reportedAt: new Date(WORLD_NOW.getTime() - rng.int(10, 600) * 1000).toISOString()
  };
}

/**
 * The gateway an output reads every stream from, by the spec's chance: its agent's own site's, where it has one, else
 * conservation.tv. Null, choosing per stream, otherwise.
 */
function inputGatewayOf(build: Build, rng: Rng, deviceId: string | null): string | null {
  if (!rng.chance(build.spec.operating.outputInputGateways)) return null;
  const networkId = build.agents.find(agent => agent.id === deviceId)?.networkId;
  const own = build.gateways.filter(gateway => gateway.networkId === networkId);
  return own.length ? rng.pick(own).id : BUILTIN_GATEWAY_ID;
}

/** Outputs follow shows (or are driven from outside), run on an agent (or none yet), and go out to channels. */
function outputsOf(build: Build, shows: ShowRow[], channels: ChannelRow[]) {
  const outputs: OutputRow[] = [];
  const outputControls: Record<string, OutputControl> = {};
  for (let o = 0; o < build.spec.outputs; o++) {
    // Draws from its own stream in a fixed order (placement, ID, forwards, preview, recorder, settings, control), so
    // its values don't move when anything else changes.
    const rng = build.root.child('output', o);
    const created = after(rng, build.orgCreated);
    const { show, deviceId } = placementOf(build, rng, o, shows);
    const id = rng.uuid(created);
    const forwards = forwardsOf(build, rng, created, channels);
    const previews = previewsOf(rng, created);
    const recorders = outputRecordersOf(rng, created);
    const controlChannels = controlChannelsOf(rng, created, channels, forwards);
    const output: OutputRow = {
      name: build.names.output(show?.name ?? null, o),
      id,
      createdAt: created.toISOString(),
      control: show ? 'show' : 'external',
      showId: show?.id ?? null,
      inputGatewayId: inputGatewayOf(build, rng.child('input-gateway'), deviceId),
      width: 1920,
      height: 1080,
      fps: rng.pick([25, 30]),
      bitrateKbps: rng.pick([4500, 6000]),
      keyframeSeconds: 2,
      device: deviceId ? { createdAt: after(rng.child('device-at'), created).toISOString(), deviceId } : null,
      recorders,
      forwards,
      controlChannels,
      previews
    };
    outputs.push(output);
    if (show) show.outputs.push({ name: output.name, id: output.id });
    if (deviceId) outputControls[id] = controlOf(build, rng, id, deviceId);
  }
  return { outputs, outputControls };
}

/**
 * Chat commands of the organisation's own: each replies. The cameras, the layout and the mix are the standard
 * commands'.
 */
function chatCommandsOf(build: Build): ChatCommandRow[] {
  const chatCommands: ChatCommandRow[] = [];
  for (let c = 0; c < build.spec.chatCommands; c++) {
    const rng = build.root.child('chat-command', c);
    const created = after(rng, build.orgCreated);
    const id = rng.uuid(created);
    chatCommands.push({
      id,
      name: build.names.command(c),
      action: { kind: 'reply', text: 'Welcome to the sanctuary! Type !scenecams to see who is on screen.' },
      audience: rng.pick(['everyone', 'everyone', 'subscriber', 'moderator', 'vip', 'broadcaster']),
      cooldownSeconds: rng.pick([0, 30, 60, 300]),
      enabled: rng.chance(0.85),
      triggeredAt: rng.chance(0.6) ? new Date(WORLD_NOW.getTime() - rng.int(60, 86_400) * 1000).toISOString() : null,
      createdAt: created.toISOString()
    });
  }
  return chatCommands;
}

/** Browsers members have used the studio from, as the API registers them (organisations.browser.ensure). */
function addBrowsers(build: Build, members: MemberRow[]) {
  for (const [index, member] of members.entries()) {
    const rng = build.root.child('browser', index);
    if (index > 0 && !rng.chance(0.6)) continue;
    const name = rng.pick(['Chrome on macOS', 'Safari on iPhone', 'Firefox on Windows', 'Edge on Windows']);
    const row = addDevice(build, rng, 'browser', name, null, after(rng, new Date(member.joinedAt)));
    row.userId = member.userId;
    row.memberName = member.displayName;
  }
}

/** A world with only the account in it: what an account in no organisation has. */
function emptyWorld(
  spec: WorldSpec,
  viewer: Viewer,
  organisations: OrganisationListing[],
  myInvitations: MyInvitationRow[]
): World {
  return {
    spec,
    now: WORLD_NOW.toISOString(),
    viewer,
    organisations,
    members: [],
    invitations: [],
    myInvitations,
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
    addresses: {},
    endpoints: {},
    outputControls: {},
    incidents: []
  };
}

export function generateWorld(spec: WorldSpec): World {
  const root = new Rng(`world/${spec.seed}`);
  const names = new Namer(spec.names, root.child('names'));
  const viewer = viewerOf(root, names);
  const organisations = organisationsOf(spec, root, names);
  const empty = emptyWorld(spec, viewer, organisations, myInvitationsOf(spec, root, names));
  const organisation = organisations[0];
  if (!organisation) return empty;

  const build: Build = {
    spec,
    root,
    names,
    now: empty.now,
    organisation,
    orgCreated: new Date(organisation.createdAt),
    devices: [],
    agents: [],
    cameras: [],
    gateways: [],
    networks: [],
    addresses: {},
    endpoints: {},
    sites: []
  };
  const members = membersOf(build, viewer);
  const invitations = invitationsOf(build, viewer);
  for (let n = 0; n < spec.networks; n++) addSite(build, n);
  const cameraStreams = streamsOf(build);
  const { shows, showStreams } = showsOf(build, cameraStreams);
  const pushed = pushedStreamsOf(build, members);
  const streams = withCodes(build, [...cameraStreams, ...pushed.streams]);
  const publishing = publishingOf(build, pushed.streams);
  const sources: ShowSources = {
    organisationId: organisation.id,
    streams,
    cameras: build.cameras,
    showStreams,
    states: []
  };
  const live = new Set(publishing);
  for (const [s, show] of shows.entries()) operateShow(build, s, show, sources, pushed, live);
  const channels = channelsOf(build);
  const { outputs, outputControls } = outputsOf(build, shows, channels);
  const chatCommands = chatCommandsOf(build);
  addBrowsers(build, members);

  const world: World = {
    ...empty,
    members,
    invitations: byId(invitations),
    networks: byId(build.networks),
    devices: byId(build.devices),
    agents: byId(build.agents),
    cameras: byId(build.cameras),
    gateways: byId(build.gateways),
    streams: byId(streams),
    shows: byId(shows),
    showStreams,
    sharedStreams: pushed.sharedStreams,
    personalStreams: pushed.personalStreams,
    publishing,
    outputs: byId(outputs),
    channels: byId(channels),
    chatCommands: byId(chatCommands),
    addresses: build.addresses,
    endpoints: build.endpoints,
    outputControls
  };
  return assignHealth(world, root.child('health'));
}
