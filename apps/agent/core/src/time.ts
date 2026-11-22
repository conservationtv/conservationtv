// The time the agent's stores keep, and the timers they are woken by. A store never reads the clock or sets a timer
// itself: each event says when it happened, and what the store should be woken for, and when, is read off its state.
// `Alarms` keeps the timers that say so, and `within` the deadlines of what an effect waits on. Both run on a `Time`,
// the real one unless told otherwise, so a store can be run with a clock that moves only when it is told to.

/** The clock, and timers on it. The real ones, unless told otherwise. */
export interface Time {
  /** Epoch milliseconds. */
  now: () => number;
  /** Call `fire` in `ms`. What it returns cancels that, if it hasn't happened yet. */
  after: (ms: number, fire: () => void) => () => void;
}

export const realTime: Time = {
  now: () => Date.now(),
  after: (ms, fire) => {
    const timer = setTimeout(fire, ms);
    return () => clearTimeout(timer);
  }
};

/** Run `work` with a signal that aborts after `ms`, saying `late`, or when `also` does. */
export async function within<T>(
  time: Time,
  ms: number,
  also: AbortSignal,
  work: (signal: AbortSignal) => Promise<T>,
  late = 'It took too long'
): Promise<T> {
  const timeout = new AbortController();
  const cancel = time.after(ms, () => timeout.abort(new DOMException(late, 'TimeoutError')));
  const signal = AbortSignal.any([timeout.signal, also]);
  try {
    return await work(signal);
  } finally {
    cancel();
  }
}

interface Armed {
  /** Epoch milliseconds. */
  at: number;
  cancel: () => void;
}

/**
 * The timers a store is woken by, kept to what its state wants (`wanted`: each alarm by name, at a time in epoch
 * milliseconds) each time it is synced: an alarm the state no longer wants is cancelled, and one at a new time set for
 * it. When one rings, `ring` wakes the store with its name and the time, and the alarms are synced again: one that
 * rang early, by the clock's say, is set again for its time.
 */
export class Alarms<Name extends string = string> {
  private readonly timers = new Map<Name, Armed>();

  constructor(
    private readonly time: Time,
    private readonly wanted: () => ReadonlyMap<Name, number>,
    private readonly ring: (name: Name, at: number) => void
  ) {}

  /** How many are set. */
  get armed(): number {
    return this.timers.size;
  }

  /** Set the alarms to what the state wants now. */
  sync(): void {
    const wanted = this.wanted();
    const names = new Set<Name>([...wanted.keys(), ...this.timers.keys()]);
    for (const name of names) {
      // An alarm the state wants at a time other than the one it is set for is set again; one it no longer wants is
      // only cancelled.
      const at = wanted.get(name);
      const armed = this.timers.get(name);
      if (armed?.at === at) continue;
      armed?.cancel();
      this.timers.delete(name);
      if (at === undefined) continue;
      const now = this.time.now();
      const cancel = this.time.after(Math.max(0, at - now), () => this.fire(name));
      this.timers.set(name, { at, cancel });
    }
  }

  private fire(name: Name): void {
    this.timers.delete(name);
    const at = this.time.now();
    this.ring(name, at);
    this.sync();
  }
}
