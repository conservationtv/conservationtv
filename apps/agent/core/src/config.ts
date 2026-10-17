import { createStore } from '@conservationtv/store';

/** What an agent is started with. The host supplies it; handlers read it with `useConfig()`. */
export interface AgentConfiguration {
  name: string;
  /** The studio API the agent starts its iroh sessions with. */
  studioUrl: string;
  /**
   * The secret key of the agent's device in the studio: its 32-byte Ed25519 seed. Its public half is the agent's iroh
   * endpoint id and the device's public ID, so this key is the agent's identity and must stay the same across restarts.
   */
  secretKey: Uint8Array;
}

export const [withConfig, useConfig] = createStore<AgentConfiguration>('config');
