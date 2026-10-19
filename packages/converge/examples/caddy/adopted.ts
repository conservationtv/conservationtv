import { AdoptedProcess } from '@conservationtv/converge/process';
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
 * Caddy as a process of its own, outliving the agent, through `AdoptedProcess`: it runs detached and is found again
 * through its pidfile. When the agent stops, Caddy carries on serving: stopping isn't removing. When the agent starts
 * again, it finds Caddy, checks it really is the Caddy it left and that it was started from this binary, and adopts
 * it without a restart. Only removing the key, through `finalize`, stops Caddy.
 *
 * The site is loaded over the admin API once Caddy answers, whether started, adopted or restarted after a crash.
 * Loading the same config again is a no-op for Caddy, so an adopted Caddy already serving the spec is undisturbed.
 */
export class AdoptedCaddyRuntime {
  readonly status$ = new BehaviorSubject<CaddyStatus>(STOPPED);
  private readonly admin: CaddyAdmin;
  private readonly process: AdoptedProcess;
  private readonly watching: Subscription;
  /** What Caddy should be serving; `null` once removed. */
  private spec: CaddySpec | null = null;

  constructor(private readonly options: CaddyOptions) {
    this.admin = new CaddyAdmin(options.admin);
    this.process = new AdoptedProcess(options.directory, caddyProcess(this.admin));
    // Caddy is serving the spec exactly while its process is running: the site is loaded before that is reported.
    this.watching = this.process.status$.subscribe(status => {
      this.update({ ...status, serving: status.state === 'running' ? this.spec : null });
    });
  }

  /** Adopts the Caddy left running, or starts one, then has it serve `spec`. Resolves once it is serving. */
  async execute(spec: CaddySpec, signal: AbortSignal): Promise<void> {
    this.spec = spec;
    const boot = await writeBootConfig(this.options);
    const { binary } = this.options;
    await this.process.ensure(
      { key: binary, binary, args: ['run', '--config', boot], configure: signal => this.admin.load(spec, signal) },
      signal
    );
  }

  /** Stops Caddy, gracefully if it will go, including one left running by an earlier agent. */
  finalize(): Promise<void> {
    this.spec = null;
    return this.process.stop();
  }

  /** The agent is stopping. Caddy is left running for the next agent to adopt; only the watching stops. */
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
