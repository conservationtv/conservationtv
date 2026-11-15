import type {
  SignalBroadcast,
  SignalChannel,
  SignalGateway,
  SignalNetwork,
  SignalSource,
  SignalStatus,
  SignalSubgroup,
  SignalSystem
} from '@/components/signal/signal-system';

// A made-up sanctuary for the signal prototype: its four channels, its two broadcasts, and the cameras and ingests
// feeding them; and the states it can be in. Design data only; nothing reads the API.

const FULL = 'full';
const SOCIAL = 'social';

const CHANNELS: SignalChannel[] = [
  {
    id: 'twitch-sanctuary',
    platform: 'twitch',
    handle: '/alveussanctuary',
    broadcast: FULL,
    status: 'ok',
    level: 3,
    viewers: 1843
  },
  { id: 'twitch-gg', platform: 'twitch', handle: '/alveusgg', broadcast: FULL, status: 'ok', level: 3, viewers: 212 },
  {
    id: 'youtube',
    platform: 'youtube',
    handle: '@AlveusSanctuary',
    broadcast: FULL,
    status: 'ok',
    level: 3,
    viewers: 96
  },
  {
    id: 'tiktok',
    platform: 'tiktok',
    handle: '@AlveusSanctuary',
    broadcast: SOCIAL,
    status: 'ok',
    level: 3,
    viewers: 408
  }
];

const BROADCASTS: SignalBroadcast[] = [
  {
    id: FULL,
    name: 'Full broadcast',
    width: 1920,
    height: 1080,
    recording: true,
    agent: 'Windows OBS agent',
    status: 'ok'
  },
  {
    id: SOCIAL,
    name: 'Social media broadcast',
    width: 1080,
    height: 1920,
    recording: false,
    agent: 'Windows OBS agent',
    status: 'ok'
  }
];

const CLOUD: SignalGateway = { id: 'gateway', name: 'conservation.tv gateway', hosted: true };
const ONSITE: SignalGateway = { id: 'onsite', name: 'On-site gateway (barn-gw)', hosted: false };

const NETWORKS: SignalNetwork[] = [
  { id: 'main', name: 'Main building', agent: 'pi-03', status: 'ok' },
  { id: 'outdoor', name: 'Outdoor enclosures', agent: 'pi-04', status: 'ok' },
  { id: 'barn', name: 'Barn and pasture', agent: 'pi-05', status: 'ok' }
];

const agentOf = (network: string) => NETWORKS.find(each => each.id === network)?.agent ?? '';

interface CameraSample {
  id: string;
  name: string;
  model: string;
  network: string;
  social?: boolean;
}

const camera = ({ id, name, model, network, social = false }: CameraSample): SignalSource => ({
  id,
  name,
  device: `${model} · ${agentOf(network)}`,
  kind: 'camera',
  status: 'ok',
  feeds: social ? [FULL, SOCIAL] : [FULL],
  network
});

const CAMERAS: SignalSource[] = [
  camera({ id: 'serval', name: 'Serval (west)', model: 'Axis P1468', network: 'main', social: true }),
  camera({ id: 'fox', name: 'Fox den', model: 'Axis M3088', network: 'outdoor', social: true }),
  camera({ id: 'crow', name: 'Crow outdoor', model: 'Reolink RLC-811', network: 'outdoor' }),
  camera({ id: 'marmoset', name: 'Marmoset indoor', model: 'Axis P1468', network: 'main', social: true }),
  camera({ id: 'pasture', name: 'Pasture', model: 'Reolink RLC-811', network: 'barn' }),
  camera({ id: 'parrots', name: 'Parrots', model: 'Axis M3088', network: 'main' }),
  camera({ id: 'extra-0', name: 'Chickens', model: 'Axis M3088', network: 'barn' }),
  camera({ id: 'extra-1', name: 'Wolf run', model: 'Axis M3088', network: 'outdoor' }),
  camera({ id: 'extra-2', name: 'Reptile room', model: 'Axis M3088', network: 'main' }),
  camera({ id: 'extra-3', name: 'Nuthouse', model: 'Axis M3088', network: 'main' }),
  camera({ id: 'extra-4', name: 'Pond', model: 'Axis M3088', network: 'outdoor' }),
  camera({ id: 'extra-5', name: 'Insect lab', model: 'Axis M3088', network: 'main' }),
  camera({ id: 'extra-6', name: 'Pig pen', model: 'Axis M3088', network: 'barn' }),
  camera({ id: 'extra-7', name: 'Rat cage', model: 'Axis M3088', network: 'main' })
];

const SUBGROUPS: SignalSubgroup[] = [
  { id: 'sub-indoor', name: 'Indoor enclosures', network: 'main', cameras: ['marmoset', 'parrots', 'extra-3'] },
  { id: 'sub-small', name: 'Small animals', network: 'main', cameras: ['extra-2', 'extra-5', 'extra-7'] },
  { id: 'sub-predators', name: 'Predators', network: 'outdoor', cameras: ['fox', 'extra-1'] }
];

const INGESTS: SignalSource[] = [
  { id: 'studio', name: 'Studio desk', device: 'OBS on studio-pc', kind: 'obs', status: 'ok', feeds: [FULL] },
  { id: 'field', name: 'Field phone', device: 'RTMP push', kind: 'rtmp', status: 'unknown', feeds: [FULL] }
];

const HEALTHY: SignalSystem = {
  channels: CHANNELS,
  broadcasts: BROADCASTS,
  gateways: [CLOUD],
  networks: NETWORKS,
  cameras: CAMERAS,
  subgroups: SUBGROUPS,
  ingests: INGESTS,
  routes: {}
};

const withCamera = (system: SignalSystem, id: string, status: SignalStatus): SignalSystem => ({
  ...system,
  cameras: system.cameras.map(each => (each.id === id ? { ...each, status } : each))
});

const withNetwork = (system: SignalSystem, id: string, status: SignalStatus): SignalSystem => ({
  ...system,
  networks: system.networks.map(each => (each.id === id ? { ...each, status } : each))
});

const withChannel = (system: SignalSystem, id: string, change: Partial<SignalChannel>): SignalSystem => ({
  ...system,
  channels: system.channels.map(each => (each.id === id ? { ...each, ...change } : each))
});

const withBroadcast = (system: SignalSystem, id: string, status: SignalStatus): SignalSystem => ({
  ...system,
  broadcasts: system.broadcasts.map(each => (each.id === id ? { ...each, status } : each))
});

const struggling = (system: SignalSystem) => withChannel(system, 'twitch-sanctuary', { status: 'degraded', level: 1 });

export interface SignalScenario {
  key: string;
  label: string;
  note: string;
  system: SignalSystem;
}

export const SCENARIOS: SignalScenario[] = [
  { key: 'healthy', label: 'All healthy', note: 'Every camera sending, every channel live.', system: HEALTHY },
  {
    key: 'camera-down',
    label: 'A camera down',
    note: 'Nuthouse, in the main building, has stopped sending.',
    system: withCamera(HEALTHY, 'extra-3', 'failing')
  },
  {
    key: 'agent-down',
    label: 'A network’s agent down',
    note: 'pi-05 isn’t answering: nothing in the barn can be seen.',
    system: withNetwork(HEALTHY, 'barn', 'failing')
  },
  {
    key: 'channel-struggling',
    label: 'A channel struggling',
    note: 'Twitch is dropping frames on /alveussanctuary.',
    system: struggling(HEALTHY)
  },
  {
    key: 'broadcast-down',
    label: 'A broadcast down',
    note: 'The social broadcast’s renderer has stopped; TikTok gets nothing.',
    system: withChannel(withBroadcast(HEALTHY, SOCIAL, 'failing'), 'tiktok', {
      status: 'affected',
      level: 0,
      viewers: undefined
    })
  },
  {
    key: 'onsite',
    label: 'Two gateways',
    note: 'The barn’s cameras go through an on-site gateway, a second rail.',
    system: { ...HEALTHY, gateways: [CLOUD, ONSITE], routes: { barn: ONSITE.id } }
  },
  {
    key: 'bad-day',
    label: 'A bad day',
    note: 'A camera down, the barn’s agent down and Twitch struggling, all at once.',
    system: struggling(withNetwork(withCamera(HEALTHY, 'extra-3', 'failing'), 'barn', 'failing'))
  }
];

/** What the prototype opens with: one network, so the map shows a group both ways. */
export const OPEN_AT_FIRST = ['outdoor'];
