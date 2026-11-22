import { useEffect, useState, useSyncExternalStore } from 'react';
import type { DesktopBridge, DesktopState, LogLine } from '../shared/bridge.ts';

// The main process, as the renderer reads it: the preload's bridge (src/preload/index.ts), and hooks over what it
// pushes.

declare global {
  interface Window {
    desktop: DesktopBridge;
  }
}

export const desktop = window.desktop;

const INITIAL: DesktopState = { agent: null, state: 'stopped', runtimes: [], error: null };

// One store of the agent's state for every component: what the main process last pushed, asked for once.
let latest = INITIAL;
const listeners = new Set<() => void>();
desktop.onState(state => {
  latest = state;
  for (const listener of listeners) listener();
});
void desktop.state().then(state => {
  latest = state;
  for (const listener of listeners) listener();
});

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The agent as the main process last said it was. */
export function useDesktopState(): DesktopState {
  return useSyncExternalStore(subscribe, () => latest);
}

/** How many lines the log view keeps. */
const SHOWN_LINES = 300;

/**
 * The agent's latest log lines, oldest first: those the main process kept, asked for once, then each as it is pushed.
 * Lines pushed before the answer arrives wait for it, and only those after its last line are added to it.
 */
export function useLogLines(): LogLine[] {
  const [lines, setLines] = useState<LogLine[]>([]);
  useEffect(() => {
    let live = true;
    // Lines pushed before the first ask is answered, which may be in its answer too.
    let pending: LogLine[] | undefined = [];
    const unsubscribe = desktop.onLog(line => {
      if (!live) return;
      if (pending !== undefined) pending.push(line);
      else setLines(current => [...current, line].slice(-SHOWN_LINES));
    });
    void desktop.logs().then(initial => {
      // Once unmounted, nothing; otherwise the kept lines, then those pushed since that come after the last of them.
      if (!live) return;
      const last = initial.at(-1)?.timestamp ?? 0;
      const after = (pending ?? []).filter(line => line.timestamp > last);
      pending = undefined;
      setLines([...initial, ...after].slice(-SHOWN_LINES));
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);
  return lines;
}
