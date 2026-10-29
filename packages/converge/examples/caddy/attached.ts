import { AttachedProcess } from '@conservationtv/converge/process';
import { BehaviorSubject, type Subscription } from 'rxjs';
import {
  CaddyAdmin,
  type CaddyOptions,
  type CaddySpec,
  type CaddyStatus,
  STOPPED,
  caddyProcess,
  writeBootConfig
} from './caddy.ts';

/**
 * Caddy as the agent's own child, through `AttachedProcess`: it lives and dies with the agent. Stopping the agent
 * stops Caddy, and if the agent exits, execa's `cleanup` takes Caddy with it. On the next start, converge hands the
 * spec back and Caddy is started afresh. Simple, at the cost of downtime whenever the agent restarts.
 *
 * The site is loaded over the admin API once Caddy answers, whether already running, started or restarted after a
 * crash. Loading the same config again is a no-op for Caddy, so a changed spec is a reload in place.
 */
export class AttachedCaddyRuntime {
  readonly status$ = new BehaviorSubject<CaddyStatus>(STOPPED);
  private readonly admin: CaddyAdmin;
  private readonly process: AttachedProcess;
  private readonly watching: Subscription;
  /** What Caddy should be serving; `null` once removed. */
  private spec: CaddySpec | null = null;

  constructor(private readonly options: CaddyOptions) {
    this.admin = new CaddyAdmin(options.admin);
    this.process = new AttachedProcess(options.directory, caddyProcess(this.admin));
    // Caddy is serving the spec exactly while its process is running: the site is loaded before that is reported.
    this.watching = this.process.status$.subscribe(status => {
      this.update({ ...status, serving: status.state === 'running' ? this.spec : null });
    });
  }

  /** Starts Caddy if it isn't running, then has it serve `spec`. Resolves once it is serving. */
  async execute(spec: CaddySpec, signal: AbortSignal): Promise<void> {
    this.spec = spec;
    const boot = await writeBootConfig(this.options);
    const { binary } = this.options;
    await this.process.ensure(
      { key: binary, binary, args: ['run', '--config', boot], configure: signal => this.admin.load(spec, signal) },
      signal
    );
  }

  /** Stops Caddy, gracefully if it will go. */
  finalize(): Promise<void> {
    this.spec = null;
    return this.process.stop();
  }

  /** The agent is stopping, and Caddy goes with it. */
  dispose(): void {
    this.watching.unsubscribe();
    this.process.dispose();
    this.status$.complete();
  }

  private update(status: CaddyStatus): void {
    if (this.status$.closed) return;
    this.status$.next(status);
  }
}
