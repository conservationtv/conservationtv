import { Agent, type AgentStatus } from '@conservationtv/agent-api';
import { getLogger, type Sink } from '@logtape/logtape';
import type { Subscription } from 'rxjs';
import type { DesktopState, RuntimeView } from '../shared/bridge.ts';
import { agentDirectory, type AgentSettings } from './settings.ts';

// The agent this app runs, in its main process: the core as a library (apps/agent/core), as the runner runs it
// (apps/agent/runner) but configured from the app's settings rather than the environment. Starting, stopping and
// replacing it are done one at a time, in order, so a stop asked for while the agent starts waits for the start to
// settle and then stops what it started.

const logger = getLogger(['desktop', 'host']);

const STOPPED: Omit<DesktopState, 'agent'> = { state: 'stopped', runtimes: [], error: null };

/** The runtimes the studio has asked for: a key finalised, with no revision, is one it has not. */
function runtimesOf(status: AgentStatus): RuntimeView[] {
  if (status.system === null) return [];
  return Object.entries(status.system)
    .filter(([, key]) => !(key.apply.state === 'applied' && key.apply.revision === null))
    .map(([key, { apply }]) => ({ key, apply: apply.state, error: apply.state === 'failed' ? apply.error : null }));
}

export class AgentHost {
  private settings: AgentSettings | undefined = undefined;
  private agent: Agent | undefined = undefined;
  private watching: Subscription | undefined = undefined;
  private current: DesktopState = { agent: null, ...STOPPED };
  private queue: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<(state: DesktopState) => void>();

  /** The running agent's log sink: its warnings and errors go to the studio API while it runs. */
  readonly logSink: Sink = record => this.agent?.logSink(record);

  get state(): DesktopState {
    return this.current;
  }

  /** The agent the app is set up as, if it is. */
  get configured(): AgentSettings | undefined {
    return this.settings;
  }

  subscribe(listener: (state: DesktopState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Run as `settings` from now on, stopping the agent running before; `undefined` runs none. Doesn't start it. */
  use(settings: AgentSettings | undefined): Promise<void> {
    return this.enqueue(async () => {
      await this.stopAgent();
      this.settings = settings;
      this.update({ agent: settings === undefined ? null : identityOf(settings), ...STOPPED });
    });
  }

  /** Start the agent the app is set up as, unless it already runs. A failure is shown, not thrown. */
  start(): Promise<void> {
    return this.enqueue(async () => {
      const settings = this.settings;
      if (settings === undefined || this.agent !== undefined) return;
      const agent = new Agent({
        type: 'conservationtv',
        name: settings.name,
        secretKey: settings.secretKey,
        studioUrl: settings.apiUrl,
        directory: agentDirectory(settings.id),
        // Electron's executable is the app: as Node, for the scripts the agent hands other programs, it needs telling.
        node: { path: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } }
      });
      this.agent = agent;
      this.watching = agent.status$.subscribe(status =>
        this.update({ state: status.state, runtimes: runtimesOf(status), error: status.error })
      );
      try {
        await agent.start();
      } catch (error) {
        logger.error('The agent could not start: {error}', { error });
        this.release();
        this.update({ ...STOPPED, error: error instanceof Error ? error.message : String(error) });
      }
    });
  }

  /** Stop the agent, once whatever is under way has settled. */
  stop(): Promise<void> {
    return this.enqueue(() => this.stopAgent());
  }

  private async stopAgent() {
    const agent = this.agent;
    if (agent === undefined) return;
    try {
      await agent.stop();
    } finally {
      this.release();
      this.update(STOPPED);
    }
  }

  private release() {
    this.watching?.unsubscribe();
    this.watching = undefined;
    this.agent = undefined;
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.queue.then(task);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private update(change: Partial<DesktopState>) {
    this.current = { ...this.current, ...change };
    for (const listener of this.listeners) listener(this.current);
  }
}

function identityOf(settings: AgentSettings) {
  return { id: settings.id, name: settings.name, apiUrl: settings.apiUrl };
}
