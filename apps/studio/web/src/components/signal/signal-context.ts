import { createContext, use, useEffect, useState, useSyncExternalStore, type RefObject } from 'react';
import { useSelector } from '@xstate/store-react';

import { intro } from '@/components/signal/signal-motion';
import type { SignalStore } from '@/components/signal/signal-store';
import type { SignalSystem } from '@/components/signal/signal-system';
import { NO_FOCUS, type SignalFocus, type SignalTopology } from '@/components/signal/signal-topology';

// What the signal view's parts read instead of being handed it: the store, what's wired to what, what's picked, and
// the few things one part gives the parts inside it (a map its nodes' places, a group whether it's open).

// ---------------------------------------------------------------------------------------------------------------------
// The view: <Signal> provides these.

export const SignalStoreContext = createContext<SignalStore | null>(null);
export const SignalTopologyContext = createContext<SignalTopology | null>(null);
export const SignalFocusContext = createContext<SignalFocus>(NO_FOCUS);

function outsideSignal(): never {
  throw new Error('This is only for components inside <Signal>.');
}

export function useSignalStore(): SignalStore {
  return use(SignalStoreContext) ?? outsideSignal();
}

export function useSignalTopology(): SignalTopology {
  return use(SignalTopologyContext) ?? outsideSignal();
}

export function useSignalSystem(): SignalSystem {
  const topology = useSignalTopology();
  return topology.system;
}

/** What's picked, its path, and what stays lit. Nothing is, outside a <Signal>. */
export function useSignalFocus(): SignalFocus {
  return use(SignalFocusContext);
}

/** How one thing stands to what's picked. */
export interface SignalStanding {
  picked: boolean;
  /** Off the picked thing's path, and fading back. */
  dimmed: boolean;
}

export function useSignalStanding(id: string | undefined): SignalStanding {
  const focus = useSignalFocus();
  if (id === undefined) return { picked: false, dimmed: false };
  return { picked: focus.picked === id, dimmed: focus.lit !== null && !focus.lit.has(id) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Wide enough for the map; narrower gets the stack.

export type SignalLayout = 'map' | 'stack';

const WIDE_QUERY = '(min-width: 880px)';

function subscribeToWidth(onChange: () => void) {
  const query = window.matchMedia(WIDE_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

export function useSignalLayout(): SignalLayout {
  const wide = useSyncExternalStore(
    subscribeToWidth,
    () => window.matchMedia(WIDE_QUERY).matches,
    () => true
  );
  return wide ? 'map' : 'stack';
}

// ---------------------------------------------------------------------------------------------------------------------
// The map: where its nodes are, for the links drawn between them.

export interface SignalMapContextValue {
  /** A ref for whatever links name by `id`: a node, a rail's line, a group's join. It cleans up after itself. */
  anchor: (id: string) => (element: HTMLElement | null) => (() => void) | undefined;
  /** What has registered, by id. Read after layout, never while rendering. */
  anchors: Map<string, HTMLElement>;
  container: RefObject<HTMLDivElement | null>;
  /** Counts up as anchors come and go: something to measure again by. */
  version: number;
  /** The first draw is over: what arrives from now on comes in quicker. */
  settled: boolean;
}

export const SignalMapContext = createContext<SignalMapContextValue | null>(null);

export function useSignalMap(): SignalMapContextValue {
  const map = use(SignalMapContext);
  if (!map) throw new Error('A signal map part is rendered outside a SignalMap.');
  return map;
}

/** A ref that gives this thing a place on the map; nothing, outside one (the stack has no links to draw). */
export function useSignalAnchor(id: string) {
  const map = use(SignalMapContext);
  return map?.anchor(id);
}

/** False while the page first draws itself, then true. */
export function useSettled(): boolean {
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(true), intro.settledAfter * 1000);
    return () => clearTimeout(timer);
  }, []);
  return settled;
}

/** The gap between a column's nodes, in pixels: for something arriving among them to take back while it's shut. */
export const SignalColumnGapContext = createContext(0);

export function useSignalColumnGap(): number {
  return use(SignalColumnGapContext);
}

// ---------------------------------------------------------------------------------------------------------------------
// A group: a network, or a subgroup inside one.

export interface SignalGroupContextValue {
  id: string;
  /** 0 for a network, 1 for a subgroup in one. */
  depth: number;
  open: boolean;
  /** Opens or shuts it; nothing, for a group that's always open. */
  toggle: (() => void) | undefined;
}

export const SignalGroupContext = createContext<SignalGroupContextValue | null>(null);

export function useSignalGroup(): SignalGroupContextValue {
  const group = use(SignalGroupContext);
  if (!group) throw new Error('A signal group part is rendered outside a SignalGroup.');
  return group;
}

/** Whether the group with this id, at this depth, is the open one. */
export function useSignalOpen(id: string, depth: number): boolean {
  const store = useSignalStore();
  return useSelector(store, snapshot => snapshot.context.open[depth] === id);
}

/**
 * Whether this is one of the things its parent brings in one after another: a column's nodes on first draw, a group's
 * members as it opens. The parent says so; each such thing says not, to whatever is inside it, so only the outermost
 * moves.
 */
export const SignalItemContext = createContext(false);

export function useSignalItem(): boolean {
  return use(SignalItemContext);
}
