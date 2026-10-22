import type { Draft } from 'immer';
import type { Controllers, SystemSpec } from './controller.ts';

/**
 * A change to the spec: edits the draft of the latest spec in place, or returns a whole new spec to replace it. Runs
 * in the system's queue, against the spec the change before it left, so keep it synchronous.
 */
export type Recipe<R extends Controllers> = (draft: Draft<SystemSpec<R>>) => SystemSpec<R> | void;

/** What a mutator's `run` works with, for as long as the system it changes is running. */
export interface MutatorContext<R extends Controllers> {
  /** The latest accepted spec. */
  spec(): SystemSpec<R>;
  /** The same as the mutator's own `update`. */
  update(recipe: Recipe<R>): Promise<void>;
  /** Aborts when the system stops. From then on, `update` rejects. */
  signal: AbortSignal;
}

/**
 * Runs for as long as the system does, feeding it changes: a loop asking the studio, or a file watcher. A throw
 * fails the start; a rejection before the system stops is reported when it stops.
 */
export type MutatorRun<R extends Controllers> = (context: MutatorContext<R>) => void | Promise<void>;

/**
 * The system's one source of changes, such as the studio, an API or a file. Also a handle, so code outside `run`,
 * such as an API's routes, can change the spec through it.
 */
export interface Mutator<R extends Controllers> {
  /**
   * Resolves once the change is accepted: parsed, saved by the sink and handed to the runtimes, which is not to say
   * converged (`status$` says how far each key has got). A change that leaves the spec as it was resolves without
   * touching the sink. Rejects if the recipe throws, the result does not parse, the sink fails, or the mutator is not
   * changing a running system.
   */
  update(recipe: Recipe<R>): Promise<void>;
  /** The latest accepted spec. Throws `NotMutating` unless the mutator is changing a running system. */
  spec(): SystemSpec<R>;
  /** Whether the mutator is changing a running system. */
  readonly attached: boolean;
}

/** A change through a mutator that is not changing a running system: never started, another's, or stopped. */
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

type Attach<R extends Controllers> = (target: MutatorTarget<R>) => Attachment;

// SAFETY: every attach function is stored under the mutator it was made for, with the same `R`.
const attachments = new WeakMap<Mutator<Controllers>, Attach<Controllers>>();

/**
 * Declares the system's mutator, inferring the system it changes from where it is passed. Without `run`, it changes
 * the spec only through `update`, from outside, as an API does.
 */
export function mutator<R extends Controllers>(run?: MutatorRun<R>): Mutator<R> {
  let target: MutatorTarget<R> | undefined = undefined;
  const handle: Mutator<R> = {
    update: recipe => {
      if (target === undefined) return Promise.reject(new NotMutating());
      return target.update(recipe);
    },
    spec: () => {
      if (target === undefined) throw new NotMutating();
      return target.spec();
    },
    get attached() {
      return target !== undefined;
    }
  };

  const attach: Attach<R> = given => {
    if (target !== undefined) throw new Error('The mutator is already changing another system');
    target = given;
    const stopping = new AbortController();
    let failure: Error | undefined = undefined;
    const detach = (): Error | undefined => {
      target = undefined;
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
    const context: MutatorContext<R> = { spec: handle.spec, update: handle.update, signal: stopping.signal };
    try {
      const running = run?.(context);
      if (running instanceof Promise) void settle(running);
    } catch (error) {
      detach();
      throw error;
    }
    return { detach };
  };
  // SAFETY: looked up only by `attach` below, with the system the mutator was declared for.
  attachments.set(handle as Mutator<Controllers>, attach as Attach<Controllers>);
  return handle;
}

/** Starts `mutator` changing `target`. Throws if it is already changing another system, or its `run` throws. */
export function attach<R extends Controllers>(mutator: Mutator<R>, target: MutatorTarget<R>): Attachment {
  // SAFETY: as stored by `mutator()`, keyed by the same handle.
  const found = attachments.get(mutator as Mutator<Controllers>) as Attach<R> | undefined;
  if (found === undefined) throw new Error('Mutators are made with mutator()');
  return found(target);
}
