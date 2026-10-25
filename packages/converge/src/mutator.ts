import type { Draft } from 'immer';
import type { Controllers, SystemSpec } from './controller.ts';

/**
 * A change to the spec: edits the draft of the latest spec in place, or returns a whole new spec to replace it. Runs
 * in the system's queue, against the spec the change before it left, so keep it synchronous.
 */
export type Recipe<R extends Controllers> = (draft: Draft<SystemSpec<R>>) => SystemSpec<R> | void;

/** What a mutator's `run` works with, for as long as the system it changes is running. */
export interface MutatorContext<R extends Controllers> {
  /** The latest accepted spec. Throws `NotMutating` once the system has stopped. */
  spec(): SystemSpec<R>;
  /**
   * Resolves once the change is accepted: parsed, saved by the sink and handed to the runtimes, which is not to say
   * converged (`status$` says how far each key has got). A change that leaves the spec as it was resolves without
   * touching the sink. Rejects if the recipe throws, the result does not parse, or the sink fails, and with
   * `NotMutating` once the system has stopped.
   */
  update(recipe: Recipe<R>): Promise<void>;
  /** Aborts when the system stops. From then on, `update` rejects. */
  signal: AbortSignal;
}

/**
 * The system's one source of changes, such as the studio, an API or a file. Runs for as long as the system does,
 * feeding it changes through its context, which code outside it, such as an API's routes, can be handed too. A throw
 * fails the start; a rejection before the system stops is reported when it stops.
 */
export type MutatorRun<R extends Controllers> = (context: MutatorContext<R>) => void | Promise<void>;

/** A change through a mutator's context once the system it changed has stopped. */
export class NotMutating extends Error {
  constructor() {
    super('The mutator is not changing a running system');
    this.name = 'NotMutating';
  }
}

/** The system's side of a mutator: where its changes go, and where it reads the spec. */
export interface MutatorTarget<R extends Controllers> {
  update(recipe: Recipe<R>): Promise<void>;
  spec(): SystemSpec<R>;
}

/** A mutator changing a running system, until it is detached. */
export interface Attachment {
  /** Aborts the mutator's signal and turns its changes away. Returns what `run` rejected with before then, if it did. */
  detach(): Error | undefined;
}

/**
 * Starts `run` changing `target`, through a context that turns changes away once detached. Throws if `run` throws,
 * having detached.
 */
export function attach<R extends Controllers>(run: MutatorRun<R>, target: MutatorTarget<R>): Attachment {
  let attached = true;
  const stopping = new AbortController();
  let failure: Error | undefined = undefined;
  const detach = (): Error | undefined => {
    attached = false;
    stopping.abort();
    return failure;
  };
  // What `run` rejects with once the system is stopping is how it stopped, not a failure.
  const settle = async (running: Promise<void>): Promise<void> => {
    try {
      await running;
    } catch (error) {
      if (!stopping.signal.aborted) failure = error instanceof Error ? error : new Error(String(error));
    }
  };
  const context: MutatorContext<R> = {
    update: recipe => {
      if (!attached) return Promise.reject(new NotMutating());
      return target.update(recipe);
    },
    spec: () => {
      if (!attached) throw new NotMutating();
      return target.spec();
    },
    signal: stopping.signal
  };
  try {
    const running = run(context);
    if (running instanceof Promise) void settle(running);
  } catch (error) {
    detach();
    throw error;
  }
  return { detach };
}
