import { BehaviorSubject } from 'rxjs';
import { z } from 'zod';

/** What the demo heartbeat should do. */
export const HeartbeatSpecSchema = z.object({
  /** How often to beat. */
  intervalMs: z.number().int().min(100),
  /** What each beat says. */
  message: z.string().min(1)
});
export type HeartbeatSpec = z.output<typeof HeartbeatSpecSchema>;

export interface HeartbeatStatus {
  /** Whether a spec is applied and the heartbeat is beating. */
  running: boolean;
  intervalMs: number | null;
  message: string | null;
  /** Beats since the agent started; carried across spec changes. */
  beats: number;
  /** ISO 8601. */
  lastBeatAt: string | null;
}

const STOPPED: HeartbeatStatus = { running: false, intervalMs: null, message: null, beats: 0, lastBeatAt: null };

/** A demo runtime: beats on an interval, and reports each beat through its status. */
export class HeartbeatRuntime {
  readonly status$ = new BehaviorSubject<HeartbeatStatus>(STOPPED);
  private timer: ReturnType<typeof setInterval> | undefined = undefined;

  /** Beat at `spec`'s interval from now on. Accepted as soon as the timer is set. */
  async apply(spec: HeartbeatSpec): Promise<void> {
    this.clear();
    const current = this.status$.getValue();
    this.status$.next({ ...current, running: true, intervalMs: spec.intervalMs, message: spec.message });
    this.timer = setInterval(() => this.beat(), spec.intervalMs);
  }

  /** Stop beating. Safe when it never started. */
  async teardown(): Promise<void> {
    this.clear();
    const current = this.status$.getValue();
    this.status$.next({ ...current, running: false, intervalMs: null, message: null });
  }

  /** Stop the timer for good when the agent stops; not a removal, so the status is left as it was. */
  dispose(): void {
    this.clear();
    this.status$.complete();
  }

  private beat(): void {
    const current = this.status$.getValue();
    const now = new Date();
    const lastBeatAt = now.toISOString();
    this.status$.next({ ...current, beats: current.beats + 1, lastBeatAt });
  }

  private clear(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
