import { createStore } from '@conservationtv/store';
import type { Peers } from './iroh/admission.ts';
import type { MediamtxPorts } from './gateway/streams/ports.ts';

/** How the agent runs MediaMTX. */
export interface MediamtxSettings {
  /** The ports MediaMTX listens on, when MediaMTX's own will not do: another program has one, say. */
  ports?: MediamtxPorts;
}

/**
 * How the agent runs the Node scripts it hands to other programs, such as the launcher MediaMTX runs for a wanted input
 * (output/obs/inputs.ts).
 */
export interface NodeCommand {
  /** The executable. */
  path: string;
  /** Variables it needs set, on top of the agent's own: `ELECTRON_RUN_AS_NODE=1` for Electron's, say. */
  env?: Record<string, string>;
}

interface BaseConfiguration {
  name: string;
  /** A directory of the agent's own, where its runtimes keep what they install and run. */
  directory: string;
  /**
   * The agent's Ed25519 secret key: its 32-byte seed. Its public half is the agent's iroh endpoint id, so this key is
   * the agent's identity and must stay the same across restarts.
   */
  secretKey: Uint8Array;
  /**
   * The peers the agent serves, and whether each may connect directly, learning its IP addresses, or only through the
   * relay. Without it, every peer is served and may connect directly.
   */
  peers?: Peers;
  /** How the agent runs MediaMTX; without it, as its own child on MediaMTX's own ports. */
  mediamtx?: MediamtxSettings;
  /**
   * The port the agent's OBS serves obs-websocket on, on this machine, when its own (4455) will not do: another OBS
   * there has it, say. Only for an agent that is a show's output.
   */
  obsWebsocketPort?: number;
  /**
   * How to run the agent's Node scripts, when this process's own executable is not Node: in Electron, say. Without it,
   * by `process.execPath` as it is.
   */
  node?: NodeCommand;
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
