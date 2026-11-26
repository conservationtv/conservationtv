import type { NameStyle } from './names.ts';
import type { Range } from './rng.ts';

// What a world is generated from: a seed and a handful of knobs. A scenario is a spec; the same spec always makes the
// same world, ID for ID.

/** Chances (0–1) of each part of the topology being left half set up, as a real organisation's often is. */
export interface Gaps {
  /** A camera switched off, so it and its streams' deliveries are `off`. */
  cameraDisabled: number;
  /** A camera locked against control. */
  cameraLocked: number;
  /** A stream with no source camera. */
  streamWithoutSource: number;
  /** A network with no active agent, so nothing on it delivers or probes. */
  networkWithoutActiveAgent: number;
  /** An output with no agent running it. */
  outputWithoutDevice: number;
  /** A show left at no slots, as one never composed was: it places nothing but a takeover. */
  showUncomposed: number;
  /** A forward switched off. */
  forwardDisabled: number;
  /** A gateway whose certificate couldn't be issued. */
  gatewayTlsError: number;
}

/** The chance of each kind of root cause, per subject of that kind. */
export interface Outages {
  /** An agent stops reporting: it and everything it reports about go stale. */
  agent: number;
  /** A camera stops answering: its deliveries stop with it. */
  camera: number;
  /** A network's gateway stops serving: what it delivers isn't ready. */
  gateway: number;
  /** An output's programme fails: OBS is on its offline segment. */
  program: number;
  /** A forward stops getting through to its channel. */
  forward: number;
  /** A channel's platform says it is offline. */
  channel: number;
}

export type OutageKind = keyof Outages;

/**
 * How the world is doing. Outages are root causes, each the chance of one subject of that kind failing; what depends
 * on a failure fails with it as it would for real (an agent that stops reporting takes the deliveries it runs stale
 * with it), and the studio API's own status rule then works out what is affected.
 */
export interface HealthSpec {
  outages: Outages;
  /** Exactly this many root causes of each kind, beside any the chances pick: for scenarios about one failure. */
  incidents: Partial<Record<OutageKind, number>>;
  /** The chance of anything judged being degraded, on its own. */
  degraded: number;
  /** The chance of anything judged going quiet on its own. */
  stale: number;
  /** The chance of anything having no state at all yet. */
  unreported: number;
}

/** A fault the mock API injects into one operation's responses, for loading and error states. */
export interface Fault {
  /** Answer with this status and an error body instead. */
  status?: number;
  /** Answer after this many milliseconds. */
  delayMs?: number;
  /** Never answer. */
  hang?: boolean;
}

/**
 * What goes on in the organisation's shows and who goes live in it: each a chance per thing it is about. All none in
 * the base spec, so an ordinary world is an organisation not using them yet.
 */
export interface Operating {
  /** A stream given a short code, as chat names it (`!swap OTT FOX`). */
  streamCodes: number;
  /** A camera's stream delivered only through its site's own gateway, never to conservation.tv: no browser plays it. */
  siteOnlyStreams: number;
  /** A member who isn't an administrator let publish (`streamPublisher`). Administrators always may. */
  publishers: number;
  /** Someone who may publish having gone live from a phone or a computer before, so having their own stream. */
  personalStreams: number;
  /** A pushed stream (shared or personal) being published to right now. */
  pushedLive: number;
  /** A show with a stream armed to take over. */
  takeoverArmed: number;
  /** An armed takeover on air. */
  takeoverLive: number;
  /** An output reading every stream from one gateway (`inputGatewayId`) rather than choosing per stream. */
  outputInputGateways: number;
}

export interface WorldSpec {
  seed: string;
  /**
   * Whether the signed-in account administers the organisation, is a member let publish (`streamPublisher`), or is a
   * member who may not.
   */
  viewer: 'admin' | 'publisher' | 'member';
  names: NameStyle;
  /** The organisations the account is in; the first is the one the world is about. 0 for an account in none. */
  organisations: number;
  networks: number;
  agentsPerNetwork: Range;
  camerasPerNetwork: Range;
  /** Streams of each camera, beyond which some streams have no source at all (`gaps.streamWithoutSource`). */
  streamsPerCamera: Range;
  /** The organisation's own MediaMTX gateways on each network, beside the built-in conservation.tv relay. */
  gatewaysPerNetwork: Range;
  presetsPerCamera: Range;
  shows: number;
  /** Each show's slot count (0–6). Null for as many as the cameras it was set up with (1–4), its lineup's first. */
  slotsPerShow: Range | null;
  /** The organisation's shared pushed streams: no camera feeds them, someone publishes to them (OBS, a phone). */
  pushedStreams: number;
  outputs: number;
  /**
   * The chance of each output being driven from outside the studio (`external` control) rather than following a show:
   * a way of running one, not a gap. It follows no show, and its controller plays any of the organisation's streams.
   * Every output is driven so in a world with no shows.
   */
  externalOutputs: number;
  channels: number;
  chatCommands: number;
  /** Members beside the signed-in account. */
  members: number;
  /** The organisation's pending invitations. */
  invitations: number;
  /** Invitations waiting for the signed-in account, to other organisations. */
  myInvitations: number;
  gaps: Gaps;
  operating: Operating;
  health: HealthSpec;
  /** Faults by operation ID, such as `organisations.topology.get`. */
  faults: Record<string, Fault>;
}

export const HEALTHY: HealthSpec = {
  outages: { agent: 0, camera: 0, gateway: 0, program: 0, forward: 0, channel: 0 },
  incidents: {},
  degraded: 0,
  stale: 0,
  unreported: 0
};

export const NO_GAPS: Gaps = {
  cameraDisabled: 0,
  cameraLocked: 0,
  streamWithoutSource: 0,
  networkWithoutActiveAgent: 0,
  outputWithoutDevice: 0,
  showUncomposed: 0,
  forwardDisabled: 0,
  gatewayTlsError: 0
};

export const NOT_OPERATING: Operating = {
  streamCodes: 0,
  siteOnlyStreams: 0,
  publishers: 0,
  personalStreams: 0,
  pushedLive: 0,
  takeoverArmed: 0,
  takeoverLive: 0,
  outputInputGateways: 0
};

/** A small, healthy, fully set-up sanctuary: what a scenario changes. */
export const BASE_SPEC: WorldSpec = {
  seed: 'base',
  viewer: 'admin',
  names: 'normal',
  organisations: 1,
  networks: 2,
  agentsPerNetwork: [1, 1],
  camerasPerNetwork: [2, 3],
  streamsPerCamera: [1, 1],
  gatewaysPerNetwork: [0, 1],
  presetsPerCamera: [0, 3],
  shows: 1,
  slotsPerShow: null,
  pushedStreams: 0,
  outputs: 1,
  externalOutputs: 0,
  channels: 1,
  chatCommands: 2,
  members: 2,
  invitations: 0,
  myInvitations: 0,
  gaps: NO_GAPS,
  operating: NOT_OPERATING,
  health: HEALTHY,
  faults: {}
};

/** A spec, partly overridden: `gaps`, `operating`, `health` and `health.outages` merge with what they override. */
export interface SpecOverrides extends Partial<Omit<WorldSpec, 'gaps' | 'operating' | 'health'>> {
  gaps?: Partial<Gaps>;
  operating?: Partial<Operating>;
  health?: HealthOverrides;
}

/** Health, partly overridden: the outages merge with the base's rather than replacing them. */
export interface HealthOverrides extends Partial<Omit<HealthSpec, 'outages' | 'incidents'>> {
  outages?: Partial<Outages>;
  incidents?: HealthSpec['incidents'];
}

export function specOf(base: WorldSpec, overrides: SpecOverrides): WorldSpec {
  return {
    ...base,
    ...overrides,
    gaps: { ...base.gaps, ...overrides.gaps },
    operating: { ...base.operating, ...overrides.operating },
    health: {
      ...base.health,
      ...overrides.health,
      outages: { ...base.health.outages, ...overrides.health?.outages },
      incidents: { ...base.health.incidents, ...overrides.health?.incidents }
    },
    faults: { ...base.faults, ...overrides.faults }
  };
}
