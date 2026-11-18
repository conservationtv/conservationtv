import { createContext, use, useEffect, useRef, type ComponentProps } from 'react';

import { useSignalStore } from '@/components/signal/signal-context';
import type { SignalStore } from '@/components/signal/signal-store';

// What the things on a signal view do when they're pressed, hovered, focused: the seam a page composes its own
// behaviour through. A thing on the view (a channel, a broadcast, a source) is a plain element, and takes plain
// element props; the view asks for them here, by what the thing is, and spreads them on. With nothing composed a press
// picks it, so its path stays in full while the rest fades. A page wraps its view in <SignalThings> to do something
// else: editing what's pressed, say, or following a link to its page. Each one is given what's composed above it, to
// keep, add to, or replace. <SignalThings> is in signal.tsx; this is what it and the views share.

/** Something on the view, by what it is and which. */
export interface SignalThing {
  kind: 'channel' | 'broadcast' | 'camera' | 'ingest';
  id: string;
}

/**
 * What a thing gets: its handlers and attributes (`onClick`, `onPointerEnter`, `aria-label`, …), as any element takes
 * them. A thing with an `onClick` is pressable, by pointer and keyboard. Not its look: the view keeps its classes.
 */
export type SignalThingProps = Omit<ComponentProps<'div'>, 'className' | 'style' | 'children'>;

/** A page's behaviour for things: from what's composed above it (`inherited`), what a thing gets now. */
export type SignalThingLayer = (thing: SignalThing, inherited: SignalThingProps) => SignalThingProps;

/** What's composed onto the view's things, from the outermost in. */
export const SignalThingsContext = createContext<readonly SignalThingLayer[]>([]);

/** The behaviour with nothing composed: a press picks the thing, or lets go of it if it's the one that's picked. */
function picking(store: SignalStore, thing: SignalThing): SignalThingProps {
  return { onClick: () => store.trigger.pick({ id: thing.id }) };
}

/** What this thing gets: picking, then each composed layer from the outermost in. */
export function useSignalThing(thing: SignalThing): SignalThingProps {
  const store = useSignalStore();
  const layers = use(SignalThingsContext);
  return layers.reduce((inherited, layer) => layer(thing, inherited), picking(store, thing));
}

// ---------------------------------------------------------------------------------------------------------------------
// Following a path by hovering: an optional piece for a page whose press does something else.

/** How soon a thing next along previews, after one has: moving between things, it follows straight on. */
const WARM_FOR = 300;

/**
 * Hover props that pick a thing once the pointer has rested on it for `delay` milliseconds, and let go as it leaves:
 * its path, previewed. A mouse's only; a touch has no hover to rest. Moving straight on to another thing previews that
 * at once.
 */
export function useSignalHoverPreview(delay: number): (thing: SignalThing) => SignalThingProps {
  const store = useSignalStore();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const warmUntil = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);
  const preview = (id: string) => {
    if (store.getSnapshot().context.picked !== id) store.trigger.pick({ id });
  };
  return thing => ({
    onPointerEnter: event => {
      if (event.pointerType !== 'mouse') return;
      clearTimeout(timer.current);
      if (Date.now() < warmUntil.current) preview(thing.id);
      else timer.current = setTimeout(() => preview(thing.id), delay);
    },
    onPointerLeave: event => {
      if (event.pointerType !== 'mouse') return;
      clearTimeout(timer.current);
      if (store.getSnapshot().context.picked !== thing.id) return;
      warmUntil.current = Date.now() + WARM_FOR;
      store.trigger.release();
    }
  });
}
