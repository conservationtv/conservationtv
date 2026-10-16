import { createStore } from '@conservationtv/store';

/** What an agent is started with. The host supplies it; handlers read it with `useConfig()`. */
export interface AgentConfiguration {
  name: string;
  /**
   * The agent's ed25519 secret key: 32 bytes. Its public half is the agent's iroh endpoint id, so this key is the
   * agent's identity and must stay the same across restarts.
   */
  secretKey: Uint8Array;
}

export const [withConfig, useConfig] = createStore<AgentConfiguration>('config');
