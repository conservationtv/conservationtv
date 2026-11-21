// What the main process and the renderer say to each other, through the preload's bridge (src/preload/index.ts).
// Plain data only: everything crosses IPC by structured clone.

/** The agent this app runs as, without its secret key, which never leaves the main process. */
export interface AgentIdentity {
  id: string;
  name: string;
  /** The studio API it belongs to. */
  apiUrl: string;
}

/** One runtime of the agent's system, as the window lists it. */
export interface RuntimeView {
  key: string;
  /** Whether the runtime has taken its latest spec: `failed` carries why not. */
  apply: 'applying' | 'applied' | 'failed';
  error: string | null;
}

/** The agent as the window shows it. */
export interface DesktopState {
  /** The agent this app is set up as, or `null` until a link from the studio sets it up. */
  agent: AgentIdentity | null;
  state: 'stopped' | 'starting' | 'running' | 'stopping';
  /** The runtimes the studio has asked for: those it has finalised are left out. */
  runtimes: RuntimeView[];
  /** Why the agent last failed to start, or why its system's status stopped. */
  error: string | null;
}

/** One line of the agent's log. */
export interface LogLine {
  /** Milliseconds since the epoch. */
  timestamp: number;
  level: 'trace' | 'debug' | 'info' | 'warning' | 'error' | 'fatal';
  category: string;
  message: string;
}

/** The bridge the preload puts on `window.desktop`. */
export interface DesktopBridge {
  state(): Promise<DesktopState>;
  onState(listener: (state: DesktopState) => void): () => void;
  logs(): Promise<LogLine[]>;
  onLog(listener: (line: LogLine) => void): () => void;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Stop the agent and forget it, key and all, after the person confirms. */
  forget(): Promise<void>;
  openDataFolder(): Promise<void>;
  openLogFolder(): Promise<void>;
}

/** The IPC channels behind the bridge. */
export const CHANNELS = {
  state: 'desktop:state',
  stateChanged: 'desktop:state-changed',
  logs: 'desktop:logs',
  logged: 'desktop:logged',
  start: 'desktop:start',
  stop: 'desktop:stop',
  forget: 'desktop:forget',
  openDataFolder: 'desktop:open-data-folder',
  openLogFolder: 'desktop:open-log-folder'
} as const;
