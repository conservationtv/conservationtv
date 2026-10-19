import { createStore } from '@conservationtv/store';

interface BaseConfiguration {
  name: string;
  /**
   * The agent's Ed25519 secret key: its 32-byte seed. Its public half is the agent's iroh endpoint id, so this key is
   * the agent's identity and must stay the same across restarts.
   */
  secretKey: Uint8Array;
  /** A directory of the agent's own, kept across restarts: each runtime keeps its binaries and state in it. */
  directory: string;
}

/** An agent on its own, on n0's public relays and address lookup, that never calls the studio API. Any key will do. */
export interface DirectConfiguration extends BaseConfiguration {
  type: 'direct';
}

/** An agent of a conservation.tv organisation: its key is its device's, and the studio API supplies its session. */
export interface ConservationTvConfiguration extends BaseConfiguration {
  type: 'conservationtv';
  /** The studio API the agent starts its iroh sessions with. */
  studioUrl: string;
}

/** What an agent is started with. The host supplies it; handlers read it with `useConfig()`. */
export type AgentConfiguration = DirectConfiguration | ConservationTvConfiguration;

export const [withConfig, useConfig] = createStore<AgentConfiguration>('config');
