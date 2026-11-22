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
  ShowRow,
  StreamRow,
  Viewer,
  World
} from './model.ts';
import { Namer } from './names.ts';
import { Rng } from './rng.ts';
import type { WorldSpec } from './spec.ts';

// A world from its spec: an organisation built the way people build one (networks, then the agents and cameras on
// them, then streams of those cameras delivered through gateways, shows placing them, outputs going out to channels),
// with whatever gaps the spec asks for, then health over the top (src/world/health.ts).

/** Where every world is in time. Fixed, so relative times ("3 minutes ago") and timestamps render the same each run. */
export const WORLD_NOW = new Date('2026-06-01T10:30:00.000Z');

/** The built-in gateway every organisation has (apps/studio/api/src/gateways/conservationtv.ts). */
export const BUILTIN_GATEWAY_ID = 'conservationtv';

const DAY_MS = 86_400_000;

export const MEMBER_ROLE = { id: '@shared/organisationMember', label: 'Member' };
export const ADMINISTRATOR_ROLE = { id: '@shared/organisationAdmin', label: 'Administrator' };

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

/** The organisations the account is in: administering the first as the spec says, and the others by chance. */
function organisationsOf(spec: WorldSpec, root: Rng, names: Namer): OrganisationListing[] {
  const organisations: OrganisationListing[] = [];
  for (let index = 0; index < spec.organisations; index++) {
    const rng = root.child('organisation', index);
    const created = daysAgo(rng, 200, 400);
    const admin = index === 0 ? spec.viewer === 'admin' : rng.chance(0.5);
    organisations.push({
      id: rng.uuid(created),
      name: names.organisation(index),
      createdAt: created.toISOString(),
      roles: admin ? [MEMBER_ROLE, ADMINISTRATOR_ROLE] : [MEMBER_ROLE]
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

/** The account first, as a founding member, then the others; a few administer it, and a few have no display name. */
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
    members.push({
      userId: rng.uuid(joined),
      displayName: rng.chance(0.9) ? person.name : null,
      joinedAt: joined.toISOString(),
      roles: rng.chance(0.25) ? [MEMBER_ROLE, ADMINISTRATOR_ROLE] : [MEMBER_ROLE]
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

/** A stream's deliveries: first through a gateway on its network when it has one, then on to the built-in relay. */
function deliveriesOf(rng: Rng, created: Date, siteGateways: GatewayRow[]): StreamRow['exposures'] {
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
      renditions: ['default'],
      publisherDeviceId: null,
      upstreamExposureId: null
    });
  }
  const relayCreated = after(rng.child('relay'), created);
  exposures.push({
    params: {},
    id: rng.child('relay').uuid(relayCreated),
    createdAt: relayCreated.toISOString(),
    gatewayId: BUILTIN_GATEWAY_ID,
    renditions: rng.chance(0.5) ? ['default', 'data_saver'] : ['default'],
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
  siteGateways: GatewayRow[]
): StreamRow {
  const created = after(rng, source ? new Date(source.device?.createdAt ?? build.orgCreated) : build.orgCreated);
  const exposures = deliveriesOf(rng, created, siteGateways);
  const recorders: StreamRow['recorders'] = [];
  const first = exposures[0];
  if (first && rng.child('recorder').chance(0.2)) {
    const recorderCreated = after(rng.child('recorder'), created);
    recorders.push({
      params: {},
      id: rng.child('recorder').uuid(recorderCreated),
      createdAt: recorderCreated.toISOString(),
      kind: 'mp4-segments',
      exposureId: first.id,
      rendition: 'default'
    });
  }
  return {
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
        const name = build.names.stream(camera.device?.name ?? 'Camera', s);
        streams.push(streamOf(build, streamRng, name, orphan ? null : camera, site.gateways));
      }
    }
  }
  if (build.spec.gaps.streamWithoutSource > 0 && streams.length === 0) {
    streams.push(streamOf(build, build.root.child('streams', 'orphan'), 'Unassigned stream', null, []));
  }
  return streams;
}

/** Shows place deliveries on the relay; one never composed places nothing. */
function showsOf(build: Build, streams: StreamRow[]): ShowRow[] {
  const relayDeliveries = streams.flatMap(stream =>
    stream.exposures.filter(exposure => exposure.gatewayId === BUILTIN_GATEWAY_ID)
  );
  const shows: ShowRow[] = [];
  for (let s = 0; s < build.spec.shows; s++) {
    const rng = build.root.child('show', s);
    const created = after(rng, build.orgCreated);
    const uncomposed = rng.child('uncomposed').chance(build.spec.gaps.showUncomposed) || relayDeliveries.length === 0;
    shows.push({
      placed: uncomposed
        ? []
        : rng
            .child('placed')
            .sample(relayDeliveries, rng.int(1, Math.min(4, relayDeliveries.length)))
            .map(exposure => exposure.id),
      name: build.names.show(s),
      id: rng.uuid(created),
      createdAt: created.toISOString(),
      outputs: []
    });
  }
  return shows;
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

/** What an output is attached to: the show it follows (none when driven from outside) and the agent running it. */
interface OutputPlacement {
  show: ShowRow | undefined;
  deviceId: string | null;
}

/** Driven from outside when there's no show to follow or the spec says so; on no agent when there's none to run it. */
function placementOf(build: Build, rng: Rng, o: number, shows: ShowRow[]): OutputPlacement {
  const external = shows.length === 0 || rng.child('external').chance(build.spec.gaps.outputExternal);
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
    const output: OutputRow = {
      name: build.names.output(show?.name ?? null, o),
      id,
      createdAt: created.toISOString(),
      control: show ? 'show' : 'external',
      showId: show?.id ?? null,
      width: 1920,
      height: 1080,
      fps: rng.pick([25, 30]),
      bitrateKbps: rng.pick([4500, 6000]),
      keyframeSeconds: 2,
      device: deviceId ? { createdAt: after(rng.child('device-at'), created).toISOString(), deviceId } : null,
      recorders,
      forwards,
      previews
    };
    outputs.push(output);
    if (show) show.outputs.push({ name: output.name, id: output.id });
    if (deviceId) outputControls[id] = controlOf(build, rng, id, deviceId);
  }
  return { outputs, outputControls };
}

/** Chat commands: replies, or a camera with presets pointed at one of them. */
function chatCommandsOf(build: Build): ChatCommandRow[] {
  const chatCommands: ChatCommandRow[] = [];
  const presetCameras = build.cameras.filter(camera => camera.presets.length > 0);
  for (let c = 0; c < build.spec.chatCommands; c++) {
    // A camera preset command when there's a camera with presets to point, more often than not; else a reply.
    const rng = build.root.child('chat-command', c);
    const created = after(rng, build.orgCreated);
    const camera = presetCameras.length && rng.chance(0.6) ? rng.pick(presetCameras) : undefined;
    chatCommands.push({
      id: rng.uuid(created),
      name: build.names.command(c),
      action: camera
        ? { kind: 'cameraPreset', cameraId: camera.id, preset: rng.pick(camera.presets).name }
        : { kind: 'reply', text: 'Welcome to the sanctuary! Type !cam to look around.' },
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
  const streams = streamsOf(build);
  const shows = showsOf(build, streams);
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
    outputs: byId(outputs),
    channels: byId(channels),
    chatCommands: byId(chatCommands),
    addresses: build.addresses,
    endpoints: build.endpoints,
    outputControls
  };
  return assignHealth(world, root.child('health'));
}
