// What a store has running outside itself (a timer, a stream, a listener on the window), each kept under a name so
// that a later event can call it off: the session's store (camera-store.ts), the store of driving by hand
// (camera-drive-context.ts) and that of the gamepad's shoulder buttons (camera-shoulders.ts) all keep theirs here.

/** Calls `fire` after `milliseconds`, unless what it returns is called first. */
export type CameraClock = (milliseconds: number, fire: () => void) => () => void;

/** The real clock. */
export const realClock: CameraClock = (milliseconds, fire) => {
  const handle = setTimeout(fire, milliseconds);
  return () => clearTimeout(handle);
};

/** What a store has running, each under a name, and how to call each off. */
export interface NamedTasks {
  /** Start something under a name, calling off whatever was running under it before. */
  start: (name: string, begin: () => () => void) => void;
  /** Call off what is running under a name, if anything is. */
  stop: (name: string) => void;
  /** Call off everything. */
  stopAll: () => void;
}

export function namedTasks(): NamedTasks {
  const running = new Map<string, () => void>();
  const stop = (name: string) => {
    const cancel = running.get(name);
    running.delete(name);
    cancel?.();
  };
  return {
    start: (name, begin) => {
      stop(name);
      running.set(name, begin());
    },
    stop,
    stopAll: () => {
      const cancels = [...running.values()];
      running.clear();
      for (const cancel of cancels) cancel();
    }
  };
}
