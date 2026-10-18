import { type Observable, combineLatest, firstValueFrom, map, shareReplay } from 'rxjs';
import { z } from 'zod';
import type { Apply, Controller, Controllers, KeyStatus, SystemSpec, SystemStatus } from './controller.ts';
import { KeyLoop } from './key.ts';
import { revisionOf } from './revision.ts';

/**
 * The only way the spec changes: a source such as an API, a file watcher or a config loader, handed the changes when
 * the system starts. Returns its cleanup.
 */
export type Mutator<R extends Controllers> = (changes: Mutations<R>) => () => void;

/** Where the spec comes from and where it is kept. Without `restore` or `sink`, nothing persists. */
export interface ConvergeOptions<R extends Controllers> {
  controllers: R;
  /**
   * The spec to start from: the last one saved, or one fixed in code. Parsed again with the system's schema, so a
   * corrupt one fails the start. Without it, the system starts from an empty spec.
   */
  restore?(): Promise<SystemSpec<R>>;
  /** Persists an accepted spec before it is applied. If it throws, the change is rejected and nothing changes. */
  sink?(spec: SystemSpec<R>): Promise<void>;
  /** Every source of changes. Their changes share one queue, so they apply in the order they are made. */
  mutators?: Mutator<R>[];
}

/**
 * Changes to the spec, handed only to mutators. Each is parsed with `schema`, and rejected if it does not parse, if the
 * sink fails, or once the system is stopping. A change that leaves the spec as it was resolves without touching the
 * sink.
 */
export interface Mutations<R extends Controllers> {
  schema: z.ZodType<SystemSpec<R>>;
  replace(spec: SystemSpec<R>): Promise<void>;
  set<K extends keyof R>(key: K, spec: SystemSpec<R>[K]): Promise<void>;
  remove(key: keyof R): Promise<void>;
}

/** A running convergence: what it reports, and how to stop it. Changes come only through its mutators. */
export interface Convergence<R extends Controllers> {
  /** Live. Never persisted: after a restart it is rebuilt from the runtimes. Errors if a runtime's status errors. */
  status$: Observable<SystemStatus<R>>;
  /** The latest status, once every key has one. */
  status(): Promise<SystemStatus<R>>;
  /** The latest accepted spec: the last one the sink persisted, and the one the runtimes are converging to. */
  spec(): SystemSpec<R>;
  /**
   * Stops taking changes, and aborts the calls in flight. Resolves once the change being saved and every call have
   * settled and every runtime is disposed, so nothing more happens after it. Never finalizes. Rejects, having still
   * done all of that, if a mutator's cleanup or a runtime's dispose threw.
   */
  stop(): Promise<void>;
}

/** One key's status, paired with its key so the system's status can be assembled. */
type KeyedStatus<Status> = readonly [string, KeyStatus<Status>];

/**
 * Starts converging every controller's runtime to the spec. Keys absent at start are finalized, so a key removed while
 * nothing was running is still torn down. If a mutator throws while starting, the system stops again and the start
 * rejects.
 */
export async function converge<R extends Controllers>(options: ConvergeOptions<R>): Promise<Convergence<R>> {
  const { controllers, sink, mutators = [] } = options;
  const SystemSchema = systemSchema(controllers);
  const restored = await options.restore?.();
  let committed = SystemSchema.parse(restored ?? {});
  const keys = Object.keys(controllers);
  // SAFETY: `committed` is parsed by the system schema, so the value at each key is parsed by its controller's `spec`.
  const loops = keys.map(key => new KeyLoop(controllers[key], committed[key] as z.output<z.ZodType> | undefined));
  let stopping = false;
  let queue = Promise.resolve();

  // One change at a time, each reading the spec the one before it left, so none is lost. Saved, then applied.
  const mutate = (change: (current: SystemSpec<R>) => SystemSpec<R>): Promise<void> => {
    if (stopping) return Promise.reject(new Error('Converge is stopping'));
    const result = queue.then(async () => {
      if (stopping) throw new Error('Converge is stopping');
      const next = SystemSchema.parse(change(committed));
      if (revisionOf(next) === revisionOf(committed)) return;
      await sink?.(next);
      committed = next;
      keys.forEach((key, index) => loops[index].want(next[key]));
    });
    queue = result.catch(() => undefined);
    return result;
  };

  const changes: Mutations<R> = {
    schema: SystemSchema,
    replace: spec => mutate(() => spec),
    set: (key, spec) => mutate(current => ({ ...current, [key]: spec })),
    remove: key =>
      mutate(current => {
        const next = { ...current };
        delete next[key];
        return next;
      })
  };

  const statuses = keys.map((key, index) => keyStatus(key, controllers[key], loops[index]));
  // Each key's status type is erased in the array. SAFETY: `statuses` has one entry per controller key, each paired
  // with the status its own controller reports.
  const toSystemStatus = map((entries: KeyedStatus<unknown>[]) => Object.fromEntries(entries) as SystemStatus<R>);
  // Only a view: the loops run on their own, so reading the status never starts or stops anything.
  const replayLatest = shareReplay<SystemStatus<R>>({ bufferSize: 1, refCount: true });
  const status$ = combineLatest(statuses).pipe(toSystemStatus, replayLatest);

  const cleanups: (() => void)[] = [];
  const halt = async (): Promise<void> => {
    stopping = true;
    const errors = cleanups.map(cleanup => attempt(cleanup));
    await Promise.all([queue, ...loops.map(loop => loop.stop())]);
    const disposals = keys.map(key => attempt(() => controllers[key].dispose?.()));
    const failures = [...errors, ...disposals].filter(error => error !== undefined);
    if (failures.length > 0) throw new AggregateError(failures, 'Converge stopped, but cleaning up failed');
  };
  let stopped: Promise<void> | undefined = undefined;
  const stop = (): Promise<void> => {
    if (stopped === undefined) stopped = halt();
    return stopped;
  };

  for (const loop of loops) loop.start();
  try {
    for (const mutator of mutators) cleanups.push(mutator(changes));
  } catch (error) {
    await stop().catch(() => undefined);
    throw error;
  }

  return {
    status$,
    status: () => firstValueFrom(status$),
    spec: () => committed,
    stop
  };
}

/** Runs `step`, returning what it threw rather than throwing, so one failure does not skip the steps after it. */
function attempt(step: () => void): Error | undefined {
  try {
    step();
    return undefined;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

/** One key's status: the runtime's own, beside how far its loop has got applying the spec. */
function keyStatus<Spec extends z.ZodType, Status>(
  key: string,
  controller: Controller<Spec, Status>,
  loop: KeyLoop<Spec, Status>
): Observable<KeyedStatus<Status>> {
  const combined = combineLatest([controller.status, loop.apply]);
  const toKeyed = map(([runtime, applied]: [Status, Apply]) => {
    const status: KeyStatus<Status> = { runtime, apply: applied };
    const keyed: KeyedStatus<Status> = [key, status];
    return keyed;
  });
  return combined.pipe(toKeyed);
}

function systemSchema<R extends Controllers>(controllers: R): z.ZodType<SystemSpec<R>> {
  const entries = Object.entries(controllers);
  const optional = entries.map(([key, controller]) => [key, controller.spec.optional()] as const);
  const fields = Object.fromEntries(optional);
  const SystemSchema = z.strictObject(fields);
  // SAFETY: each field is its controller's spec schema made optional, under the controller's key.
  return SystemSchema as z.ZodType<SystemSpec<R>>;
}
