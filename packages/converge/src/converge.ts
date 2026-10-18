import {
  BehaviorSubject,
  type Observable,
  combineLatest,
  distinctUntilChanged,
  firstValueFrom,
  lastValueFrom,
  map,
  shareReplay,
  switchMap
} from 'rxjs';
import { z } from 'zod';
import { type Revisioned, apply, revisioned } from './apply.ts';
import type { Apply, KeyStatus, Controller, Controllers, SystemSpec, SystemStatus } from './controller.ts';
import { serial } from './serial.ts';

/**
 * The only way the spec changes: a source such as an API, a file watcher or a config loader, handed the changes when
 * the system starts. Returns its cleanup.
 */
export type Mutator<R extends Controllers> = (changes: Mutations<R>) => () => void;

/** Where the spec comes from and where it is kept. Without `restore` or `sink`, nothing persists. */
export interface ConvergeOptions<R extends Controllers> {
  controllers: R;
  /** The last accepted spec, parsed with `schema`. Without it, the system starts from an empty spec. */
  restore?(schema: z.ZodType<SystemSpec<R>>): Promise<SystemSpec<R>>;
  /** Persists an accepted spec before it is applied. */
  sink?(spec: SystemSpec<R>): Promise<void>;
  /** Every source of changes. Their changes share one queue, so they apply in the order they are made. */
  mutators?: Mutator<R>[];
}

/** Changes to the spec, handed only to mutators. Callers parse input with `schema` (or a controller's `spec`) first. */
export interface Mutations<R extends Controllers> {
  schema: z.ZodType<SystemSpec<R>>;
  replace(spec: SystemSpec<R>): Promise<void>;
  set<K extends keyof R>(key: K, spec: SystemSpec<R>[K]): Promise<void>;
  remove(key: keyof R): Promise<void>;
}

/** A running convergence: what it reports, and how to stop it. Changes come only through its mutators. */
export interface Convergence<R extends Controllers> {
  /** Live. Never persisted: after a restart it is rebuilt from the runtimes. */
  status$: Observable<SystemStatus<R>>;
  /** The latest status, once every key has one. */
  status(): Promise<SystemStatus<R>>;
  /** The latest accepted spec: the last one the sink persisted, and the one the runtimes are converging to. */
  spec(): SystemSpec<R>;
  /** Stops applying, aborts any execute in flight, then disposes every runtime. Never finalizes. */
  stop(): void;
}

/** One key's status, paired with its key so the system's status can be assembled. */
type KeyedStatus<Status> = readonly [string, KeyStatus<Status>];

/**
 * Starts converging every controller's runtime to the spec. Keys absent at start are finalized, so a key removed while
 * nothing was running is still torn down.
 */
export async function converge<R extends Controllers>(options: ConvergeOptions<R>): Promise<Convergence<R>> {
  const { controllers, sink, mutators = [] } = options;
  const SystemSchema = systemSchema(controllers);
  const initial = await initialSpec(options, SystemSchema);
  const state = new BehaviorSubject(initial);
  const mutations = serial();

  // Reads the current spec inside the queue, so concurrent mutations apply in order and none is lost.
  const mutate = (change: (current: SystemSpec<R>) => SystemSpec<R>): Promise<void> => {
    const committed = mutations(async () => {
      const current = state.getValue();
      const next = change(current);
      await sink?.(next);
      state.next(next);
    });
    return lastValueFrom(committed);
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

  const keys = Object.keys(controllers);
  const tracked = keys.map(key => track(key, controllers[key], state));
  const everyKey = combineLatest(tracked);
  // Each key's status type is erased in the array. SAFETY: `tracked` has one entry per controller key, each paired with
  // the status its own controller reports.
  const toSystemStatus = map((entries: KeyedStatus<unknown>[]) => Object.fromEntries(entries) as SystemStatus<R>);
  // Counted, so unsubscribing `running` in `stop` disconnects the source: in-flight executes abort and retries stop.
  const replayLatest = shareReplay<SystemStatus<R>>({ bufferSize: 1, refCount: true });
  const status$ = everyKey.pipe(toSystemStatus, replayLatest);
  const running = status$.subscribe();
  const cleanups = mutators.map(mutator => mutator(changes));

  return {
    status$,
    status: () => firstValueFrom(status$),
    spec: () => state.getValue(),
    stop: () => {
      for (const cleanup of cleanups) cleanup();
      running.unsubscribe();
      for (const key of keys) controllers[key].dispose?.();
    }
  };
}

/** Applies one spec fixed in code at start, and never changes it. */
export function staticMutator<R extends Controllers>(spec: SystemSpec<R>): Mutator<R> {
  return changes => {
    // Without a sink, replacing the spec cannot fail.
    void changes.replace(spec);
    return () => undefined;
  };
}

async function initialSpec<R extends Controllers>(
  options: ConvergeOptions<R>,
  schema: z.ZodType<SystemSpec<R>>
): Promise<SystemSpec<R>> {
  if (options.restore === undefined) return {};
  return options.restore(schema);
}

/** One key: its latest spec, applied one at a time, beside the runtime's live status. */
function track<R extends Controllers, Spec extends z.ZodType, Status>(
  key: string,
  controller: Controller<Spec, Status>,
  state: Observable<SystemSpec<R>>
): Observable<KeyedStatus<Status>> {
  const queue = serial();
  // SAFETY: `controller` is `controllers[key]`, so the value at `key` is parsed by its `spec`.
  const toSpec = map((spec: SystemSpec<R>) => spec[key] as z.output<Spec> | undefined);
  const toRevisioned = map((spec: z.output<Spec> | undefined) => revisioned(spec));
  const onlyChanges = distinctUntilChanged<Revisioned<z.output<Spec>>>((a, b) => a.revision === b.revision);
  // A newer spec cancels pending retries and waits behind any execute in flight.
  const latestWins = switchMap((current: Revisioned<z.output<Spec>>) => apply(controller, current, queue));
  const applies = state.pipe(toSpec, toRevisioned, onlyChanges, latestWins);
  const combined = combineLatest([controller.status, applies]);
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
