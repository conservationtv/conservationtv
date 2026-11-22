import { generateWorld } from './generate.ts';
import type { World } from './model.ts';
import { Rng, type Range } from './rng.ts';
import { BASE_SPEC, HEALTHY, specOf, type SpecOverrides, type WorldSpec } from './spec.ts';

// The worlds there are: named scenarios, written for a case someone cares about, and `random-<n>`, sampled from the
// knobs for the cases nobody thought to write. Both are only specs; the generator makes the world.

export interface Scenario {
  id: string;
  title: string;
  /** What it is for, and so what to look for in its screenshots. */
  description: string;
  spec: WorldSpec;
}

function scenario(id: string, title: string, description: string, overrides: SpecOverrides): Scenario {
  return { id, title, description, spec: specOf(BASE_SPEC, { seed: id, ...overrides }) };
}

export const NAMED_SCENARIOS: Scenario[] = [
  scenario(
    'typical',
    'A typical sanctuary',
    'Two sites, a handful of cameras, one show going out to Twitch; all healthy.',
    {
      networks: 2,
      camerasPerNetwork: [2, 4],
      gatewaysPerNetwork: [1, 1],
      shows: 2,
      outputs: 2,
      channels: 2,
      members: 3,
      invitations: 1
    }
  ),
  scenario('fresh-account', 'A new account', 'Signed in, in no organisation yet, with an invitation waiting.', {
    organisations: 0,
    myInvitations: 1
  }),
  scenario(
    'empty-organisation',
    'An empty organisation',
    'Just made: no networks, cameras, streams, shows or outputs.',
    {
      networks: 0,
      shows: 0,
      outputs: 0,
      channels: 0,
      chatCommands: 0,
      members: 0
    }
  ),
  scenario(
    'first-camera',
    'First camera',
    'One site, one agent, one camera with one stream; nothing composed or going out yet.',
    {
      networks: 1,
      camerasPerNetwork: [1, 1],
      gatewaysPerNetwork: [0, 0],
      shows: 1,
      outputs: 0,
      channels: 0,
      chatCommands: 0,
      members: 0,
      gaps: { showUncomposed: 1 }
    }
  ),
  scenario(
    'site-outage',
    'A site goes dark',
    "One site's agent stops reporting: everything it delivers goes stale, and what reads it is affected.",
    {
      networks: 3,
      camerasPerNetwork: [2, 3],
      gatewaysPerNetwork: [1, 1],
      shows: 2,
      outputs: 2,
      channels: 2,
      health: { incidents: { agent: 1 } }
    }
  ),
  scenario('camera-failures', 'Cameras failing', 'Several cameras stop answering, and one gateway stops serving.', {
    networks: 2,
    camerasPerNetwork: [3, 5],
    gatewaysPerNetwork: [1, 1],
    shows: 2,
    outputs: 2,
    channels: 2,
    health: { incidents: { camera: 3, gateway: 1 } }
  }),
  scenario(
    'output-trouble',
    'Outputs in trouble',
    'Programmes on their offline segment, forwards not getting through, a channel offline.',
    {
      networks: 2,
      shows: 3,
      outputs: 4,
      channels: 3,
      health: { incidents: { program: 1, forward: 1, channel: 1 } }
    }
  ),
  scenario(
    'degraded',
    'Degraded everywhere',
    'Nothing is down, but much of it is degraded: frame errors, skipped frames, low disk.',
    {
      networks: 2,
      camerasPerNetwork: [3, 4],
      gatewaysPerNetwork: [1, 1],
      shows: 2,
      outputs: 2,
      channels: 2,
      health: { degraded: 0.6 }
    }
  ),
  scenario('quiet', 'Gone quiet', 'Half of everything has stopped reporting, and some of it never has.', {
    networks: 2,
    camerasPerNetwork: [2, 4],
    shows: 2,
    outputs: 2,
    channels: 2,
    health: { stale: 0.5, unreported: 0.25 }
  }),
  scenario(
    'half-configured',
    'Half set up',
    'Streams without cameras, a site without an active agent, outputs without agents or shows, an uncomposed show, switched-off cameras and forwards, a gateway without a certificate.',
    {
      networks: 3,
      agentsPerNetwork: [0, 2],
      camerasPerNetwork: [1, 3],
      gatewaysPerNetwork: [0, 1],
      shows: 3,
      outputs: 3,
      channels: 2,
      gaps: {
        cameraDisabled: 0.25,
        cameraLocked: 0.25,
        streamWithoutSource: 0.25,
        networkWithoutActiveAgent: 0.5,
        outputWithoutDevice: 0.4,
        outputExternal: 0.4,
        showUncomposed: 0.4,
        forwardDisabled: 0.4,
        gatewayTlsError: 0.5
      }
    }
  ),
  scenario(
    'large-estate',
    'A large estate',
    'Eight sites and around a hundred cameras, many shows and outputs, with a little of everything going wrong.',
    {
      networks: 8,
      agentsPerNetwork: [1, 3],
      camerasPerNetwork: [8, 16],
      streamsPerCamera: [1, 2],
      gatewaysPerNetwork: [1, 2],
      presetsPerCamera: [0, 8],
      shows: 8,
      outputs: 8,
      channels: 6,
      chatCommands: 12,
      members: 24,
      invitations: 5,
      health: {
        outages: { agent: 0.08, camera: 0.05, gateway: 0.05, program: 0.15, forward: 0.1, channel: 0.1 },
        degraded: 0.1,
        stale: 0.03,
        unreported: 0.03
      }
    }
  ),
  scenario('member-view', 'As a member', 'The typical sanctuary, seen by a member rather than an administrator.', {
    viewer: 'member',
    networks: 2,
    camerasPerNetwork: [2, 4],
    gatewaysPerNetwork: [1, 1],
    shows: 2,
    outputs: 2,
    channels: 2,
    members: 3,
    invitations: 1
  }),
  scenario(
    'long-names',
    'Long names',
    'Every name near its limit, with unbroken words and non-Latin text, to find what overflows.',
    {
      names: 'long',
      networks: 2,
      camerasPerNetwork: [2, 3],
      gatewaysPerNetwork: [1, 1],
      shows: 2,
      outputs: 2,
      channels: 2,
      members: 3,
      health: { incidents: { camera: 1, program: 1 } }
    }
  ),
  scenario(
    'slow-api',
    'A slow API',
    'The typical sanctuary with its topology and status never answering: what pages show while they load.',
    {
      networks: 2,
      shows: 2,
      outputs: 2,
      faults: {
        'organisations.topology.get': { hang: true },
        'organisations.status.get': { hang: true }
      }
    }
  ),
  scenario(
    'api-errors',
    'API errors',
    'The typical sanctuary with its topology, status and lists failing: the error states.',
    {
      networks: 2,
      shows: 2,
      outputs: 2,
      faults: {
        'organisations.topology.get': { status: 503 },
        'organisations.status.get': { status: 503 },
        'organisations.streams.list': { status: 500 },
        'organisations.cameras.list': { status: 500 },
        'organisations.outputs.list': { status: 503 }
      }
    }
  )
];

type Scale = 'tiny' | 'small' | 'medium' | 'large';

/** How many networks a random world of each scale has. */
const NETWORKS_BY_SCALE = { tiny: [0, 1], small: [1, 2], medium: [2, 4], large: [5, 9] } as const satisfies Record<
  Scale,
  Range
>;
/** How many cameras each of its networks has. */
const CAMERAS_BY_SCALE = { tiny: [0, 1], small: [1, 3], medium: [2, 6], large: [6, 14] } as const satisfies Record<
  Scale,
  Range
>;

/** A world sampled from the knobs: scale, gaps and health each drawn at random for seed `n`. */
export function randomScenario(n: number): Scenario {
  const rng = new Rng(`random/${n}`);
  const scale = rng.weighted({ tiny: 2, small: 4, medium: 3, large: 1 });
  const networks = NETWORKS_BY_SCALE[scale];
  const cameras = CAMERAS_BY_SCALE[scale];
  const gapLevel = rng.pick([0, 0, 0.15, 0.4]);
  const gap = (name: string) => rng.child('gap', name).float() * gapLevel;
  const healthLevel = rng.weighted({ healthy: 3, patchy: 4, bad: 2, dire: 1 });
  const outage = { healthy: 0, patchy: 0.1, bad: 0.3, dire: 0.7 }[healthLevel];
  const roll = (name: string) => rng.child('health', name).float() * outage;
  const spec = specOf(BASE_SPEC, {
    seed: `random-${n}`,
    viewer: rng.chance(0.75) ? 'admin' : 'member',
    names: rng.chance(0.15) ? 'long' : 'normal',
    organisations: rng.chance(0.75) ? 1 : rng.int(2, 3),
    networks: rng.range(networks),
    agentsPerNetwork: [rng.int(0, 1), rng.int(1, 3)],
    camerasPerNetwork: cameras,
    streamsPerCamera: [1, rng.int(1, 2)],
    gatewaysPerNetwork: [0, rng.int(0, 2)],
    presetsPerCamera: [0, rng.int(0, 8)],
    shows: rng.int(0, scale === 'large' ? 8 : 3),
    outputs: rng.int(0, scale === 'large' ? 8 : 3),
    channels: rng.int(0, scale === 'large' ? 6 : 3),
    chatCommands: rng.int(0, 8),
    members: rng.int(0, scale === 'large' ? 30 : 5),
    invitations: rng.int(0, 3),
    myInvitations: rng.int(0, 1),
    gaps: {
      cameraDisabled: gap('cameraDisabled'),
      cameraLocked: gap('cameraLocked'),
      streamWithoutSource: gap('streamWithoutSource'),
      networkWithoutActiveAgent: gap('networkWithoutActiveAgent'),
      outputWithoutDevice: gap('outputWithoutDevice'),
      outputExternal: gap('outputExternal'),
      showUncomposed: gap('showUncomposed'),
      forwardDisabled: gap('forwardDisabled'),
      gatewayTlsError: gap('gatewayTlsError')
    },
    health:
      healthLevel === 'healthy'
        ? HEALTHY
        : {
            incidents: {},
            outages: {
              agent: roll('agent') / 2,
              camera: roll('camera'),
              gateway: roll('gateway'),
              program: roll('program'),
              forward: roll('forward'),
              channel: roll('channel')
            },
            degraded: roll('degraded'),
            stale: roll('stale') / 2,
            unreported: roll('unreported') / 3
          }
  });
  return {
    id: `random-${n}`,
    title: `Random world ${n}`,
    description: `Sampled: ${scale} scale, ${healthLevel} health, ${gapLevel ? `gaps up to ${Math.round(gapLevel * 100)}%` : 'fully set up'}.`,
    spec
  };
}

/** The scenario by ID: a named one, or `random-<n>`. */
export function findScenario(id: string): Scenario | undefined {
  const named = NAMED_SCENARIOS.find(scenario => scenario.id === id);
  if (named) return named;
  const random = /^random-(\d{1,6})$/u.exec(id);
  return random ? randomScenario(Number(random[1])) : undefined;
}

const worlds = new Map<string, World>();

/** The scenario's world, generated once per process. */
export function worldOf(scenario: Scenario): World {
  let world = worlds.get(scenario.id);
  if (!world) {
    world = generateWorld(scenario.spec);
    worlds.set(scenario.id, world);
  }
  return world;
}
