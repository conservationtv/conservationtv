import { BehaviorSubject } from 'rxjs';
import type { z } from 'zod';
import type { Apply, Controller, Revision } from './controller.ts';
import { revisionOf } from './revision.ts';

const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 300_000;

/** What a key should be: its spec, and the revision that tells one spec from another. `null` while absent. */
interface Target<Spec> {
  spec: Spec | undefined;
  revision: Revision;
}

/**
 * One key's loop. Until the runtime has accepted the latest spec it calls the runtime, one call at a time; then it
 * waits for the next spec. A newer spec aborts the call in flight and is picked up as soon as that call settles, so
 * any spec in between is skipped. A failed call is retried after a backoff, which a newer spec cuts short.
 */
export class KeyLoop<Spec extends z.ZodType, Status> {
  /** How far the loop has got applying the latest spec. */
  readonly apply: BehaviorSubject<Apply>;
  private target: Target<z.output<Spec>>;
  /** The revision the runtime last accepted; `undefined` once a call failed or was cut short, as nobody knows. */
  private accepted: Revision | undefined = undefined;
  private call: AbortController | undefined = undefined;
  private wake: (() => void) | undefined = undefined;
  private stopping = false;
  private done: Promise<void> = Promise.resolve();

  constructor(
    private readonly controller: Controller<Spec, Status>,
    spec: z.output<Spec> | undefined
  ) {
    this.target = target(spec);
    this.apply = new BehaviorSubject<Apply>({ state: 'applying', revision: this.target.revision });
  }

  start(): void {
    this.done = this.run();
  }

  /** Points the loop at a new spec: the call in flight is aborted, and a backoff is cut short. */
  want(spec: z.output<Spec> | undefined): void {
    const next = target(spec);
    if (this.stopping || next.revision === this.target.revision) return;
    this.target = next;
    this.apply.next({ state: 'applying', revision: next.revision });
    this.call?.abort();
    this.wake?.();
  }

  /** Stops the loop. The call in flight is aborted, and this resolves once it has settled. */
  stop(): Promise<void> {
    this.stopping = true;
    this.call?.abort();
    this.wake?.();
    return this.done;
  }

  // Each turn either waits (the runtime has the latest spec), or makes one call for the latest spec. A call that
  // succeeds records what the runtime accepted; one that fails is retried after a backoff, unless a newer spec has
  // arrived meanwhile, which is taken up straight away with a fresh count of attempts.
  private async run(): Promise<void> {
    let tried: Target<z.output<Spec>> | undefined = undefined;
    let attempt = 0;
    while (!this.stopping) {
      // Read the latest spec afresh each turn: whatever arrived during the last call or wait is what counts now.
      const target = this.target;
      if (target.revision === this.accepted) {
        this.publish({ state: 'applied', revision: target.revision });
        await this.nap(undefined);
        continue;
      }
      attempt = target === tried ? attempt + 1 : 1;
      tried = target;
      const error = await this.attempt(target);
      if (error === undefined) {
        this.accepted = target.revision;
        continue;
      }
      this.accepted = undefined;
      if (this.stopping || target !== this.target) continue;
      this.apply.next({ state: 'failed', revision: target.revision, error: error.message, attempt });
      await this.nap(Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_MAX_MS));
    }
  }

  /** One call into the runtime for `target`, abortable through `this.call`. Resolves with what it threw, if anything. */
  private async attempt(target: Target<z.output<Spec>>): Promise<Error | undefined> {
    const call = new AbortController();
    this.call = call;
    try {
      if (target.spec !== undefined) await this.controller.execute(target.spec, call.signal);
      else await this.controller.finalize?.(call.signal);
      return undefined;
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    } finally {
      this.call = undefined;
    }
  }

  /** Waits until woken by a new spec or by stopping, or until `ms` have passed. */
  private nap(ms: number | undefined): Promise<void> {
    return new Promise(resolve => {
      const timer = ms === undefined ? undefined : setTimeout(() => this.wake?.(), ms);
      this.wake = () => {
        clearTimeout(timer);
        this.wake = undefined;
        resolve();
      };
    });
  }

  private publish(apply: Apply): void {
    const current = this.apply.getValue();
    if (current.state === apply.state && current.revision === apply.revision) return;
    this.apply.next(apply);
  }
}

function target<Spec>(spec: Spec | undefined): Target<Spec> {
  if (spec === undefined) return { spec, revision: null };
  const revision = revisionOf(spec);
  return { spec, revision };
}
