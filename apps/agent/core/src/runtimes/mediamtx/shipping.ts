import { BehaviorSubject } from 'rxjs';
import type { AgentConfiguration } from '../../config.ts';
import { type Metric, MetricReporter } from '../reporter.ts';

// Metrics collected on an interval and submitted to the studio API through a `MetricReporter`. What is collected is
// the caller's: the shipper only stamps, queues and submits it.

export interface ShippingStatus {
  /** Metrics collected but not yet accepted. */
  pending: number;
  /** Metrics accepted since the agent started; carried across spec changes. */
  submitted: number;
  /** ISO 8601. */
  lastSubmittedAt: string | null;
  /** Why the last attempt to collect or submit failed; cleared by the next success. */
  lastError: string | null;
}

const IDLE: ShippingStatus = { pending: 0, submitted: 0, lastSubmittedAt: null, lastError: null };

/** Collects metrics on an interval, and submits them. */
export class MetricShipper {
  readonly status$ = new BehaviorSubject<ShippingStatus>(IDLE);
  private readonly reporter: MetricReporter;
  private timer: ReturnType<typeof setInterval> | undefined = undefined;
  /** Whether a tick is under way: a slow submission skips the ticks it overlaps rather than piling up. */
  private ticking = false;

  constructor(config: AgentConfiguration) {
    this.reporter = new MetricReporter(config);
  }

  /** Collects with `collect` and submits every `intervalMs` from now on, replacing any earlier schedule. */
  every(intervalMs: number, collect: () => Promise<Metric[]>): void {
    this.clearTimer();
    this.timer = setInterval(() => void this.tick(collect), intervalMs);
  }

  /** Stops collecting, and drops what was not submitted. */
  stop(): void {
    this.clearTimer();
    this.reporter.clear();
    this.update({ lastError: null });
  }

  /** The agent is stopping. */
  dispose(): void {
    this.clearTimer();
    this.status$.complete();
  }

  private async tick(collect: () => Promise<Metric[]>): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const observedAt = new Date();
      this.reporter.queue(observedAt.toISOString(), await collect());
      const accepted = await this.reporter.submit();
      const current = this.status$.getValue();
      const submittedAt = new Date();
      this.update({
        submitted: current.submitted + accepted,
        lastSubmittedAt: submittedAt.toISOString(),
        lastError: null
      });
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.update({ lastError: failure.message });
    } finally {
      this.ticking = false;
    }
  }

  private update(change: Partial<ShippingStatus>): void {
    if (this.status$.closed) return;
    this.status$.next({ ...this.status$.getValue(), ...change, pending: this.reporter.pending });
  }

  private clearTimer(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
