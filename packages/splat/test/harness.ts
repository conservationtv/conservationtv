import { BehaviorSubject, type Observable, filter, firstValueFrom } from 'rxjs';
import { vi } from 'vitest';
import { z } from 'zod';
import {
  type Mutations,
  type Mutator,
  type Resolvers,
  type Splat,
  type SplatOptions,
  type SystemStatus,
  resolver,
  splat
} from '../src/index.ts';
import { revisionOf } from '../src/revision.ts';

/** The spec every fake runtime takes: which version of something to run. */
export const AppSpecSchema = z.object({ image: z.string(), version: z.number().int() });
export type AppSpec = z.output<typeof AppSpecSchema>;

export function app(version: number): AppSpec {
  return { image: 'app', version };
}

/** What a fake runtime is really running. Tests compare it with the desired spec to judge convergence. */
export interface Running {
  spec: AppSpec | undefined;
}

/** One call splat made into a runtime, held open until the test (or a driver) settles it. */
export interface Call {
  kind: 'execute' | 'finalize';
  spec: AppSpec | undefined;
  signal: AbortSignal;
  /** An execute now runs its spec; a finalize has removed whatever was running. */
  succeed(): void;
  fail(message: string): void;
}

/** Decides how each call ends, for runtimes that run without a test driving them call by call. */
export type Driver = (call: Call) => void;

/**
 * A runtime under the test's control. Every execute and finalize becomes a `Call` the test settles by hand with
 * `next()`, unless a driver settles it. It records what it was asked to do, and how many calls overlapped.
 */
export class FakeRuntime {
  readonly running = new BehaviorSubject<Running>({ spec: undefined });
  /** Every call splat made, in order. */
  readonly calls: Call[] = [];
  /** The most calls that were ever in flight at once. Splat promises one. */
  maxInFlight = 0;
  private inFlight = 0;
  private unseen: Call[] = [];
  private waiters: ((call: Call) => void)[] = [];

  /**
   * @param honoursAbort A well-behaved runtime gives up as soon as it is superseded. One that does not lets the
   *   superseded call run to completion.
   */
  constructor(
    readonly honoursAbort = true,
    private readonly driver: Driver | undefined = undefined
  ) {}

  readonly resolver = resolver({
    spec: AppSpecSchema,
    status: this.running,
    execute: (spec, signal) => this.call('execute', spec, signal),
    finalize: signal => this.call('finalize', undefined, signal)
  });

  /** The next call splat makes into this runtime, once it makes it. */
  next(): Promise<Call> {
    const call = this.unseen.shift();
    if (call !== undefined) return Promise.resolve(call);
    return new Promise(resolve => this.waiters.push(resolve));
  }

  /** How many calls have been made that the test has not taken with `next()`. */
  get waiting(): number {
    return this.unseen.length;
  }

  /** The spec of each execute, and `undefined` for each finalize, in call order. */
  get history(): (number | undefined)[] {
    return this.calls.map(call => call.spec?.version);
  }

  private call(kind: Call['kind'], spec: AppSpec | undefined, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (): boolean => {
        if (settled) return false;
        settled = true;
        this.inFlight--;
        return true;
      };
      const call: Call = {
        kind,
        spec,
        signal,
        succeed: () => {
          if (!settle()) return;
          const running: Running = { spec: kind === 'execute' ? spec : undefined };
          this.running.next(running);
          resolve();
        },
        fail: message => {
          if (!settle()) return;
          reject(new Error(message));
        }
      };
      this.inFlight++;
      this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
      this.calls.push(call);
      if (this.honoursAbort) signal.addEventListener('abort', () => call.fail('aborted'), { once: true });
      this.deliver(call);
    });
  }

  private deliver(call: Call): void {
    if (this.driver !== undefined) return this.driver(call);
    const waiter = this.waiters.shift();
    if (waiter !== undefined) return waiter(call);
    this.unseen.push(call);
  }
}

/** Settles every call after `latencyMs`, succeeding it. */
export function succeedAfter(latencyMs: number): Driver {
  return call => {
    setTimeout(() => call.succeed(), latencyMs);
  };
}

/** A running splat, and the changes the test makes to it. */
export type Controlled<R extends Resolvers> = Splat<R> & Mutations<R>;

/**
 * Starts splat with one more mutator: the test's own, holding on to the changes the way an API or a file watcher
 * would. Everything the test sets, removes or replaces goes through it.
 */
export async function started<R extends Resolvers>(options: SplatOptions<R>): Promise<Controlled<R>> {
  const handed: Mutations<R>[] = [];
  const test: Mutator<R> = changes => {
    handed.push(changes);
    return () => undefined;
  };
  const mutators = [...(options.mutators ?? []), test];
  const system = await splat({ ...options, mutators });
  const changes = handed[0];
  if (changes === undefined) throw new Error('Splat started without handing its mutators the changes');
  return { ...system, ...changes };
}

/** Resolves with the first status that satisfies `predicate`, including the current one. */
export function until<R extends Resolvers>(
  system: Splat<R>,
  predicate: (status: SystemStatus<R>) => boolean
): Promise<SystemStatus<R>> {
  const matching = filter(predicate);
  const status$: Observable<SystemStatus<R>> = system.status$;
  return firstValueFrom(status$.pipe(matching));
}

/** The revision splat reports for a spec, or `null` when the key is absent. */
export function revisionFor(spec: AppSpec | undefined): string | null {
  if (spec === undefined) return null;
  return revisionOf(spec);
}

/** Lets every pending callback, promise and zero-delay timer run, under real or fake timers. */
export async function flush(): Promise<void> {
  if (vi.isFakeTimers()) {
    await vi.advanceTimersByTimeAsync(0);
    return;
  }
  for (let turn = 0; turn < 5; turn++) await new Promise(resolve => setImmediate(resolve));
}
