import { use, useEffect, useRef, type ComponentProps, type FC, type ReactNode } from 'react';
import { useSelector, useStore } from '@xstate/store-react';
import { Badge } from '@conservationtv/ui/components/badge';
import { cn } from '@conservationtv/ui/lib/utils';

import {
  SignalFocusContext,
  SignalStoreContext,
  SignalTopologyContext,
  useSignalStore,
  useSignalTopology
} from '@/components/signal/signal-context';
import { Swap } from '@/components/signal/signal-presence';
import { signalStoreConfig } from '@/components/signal/signal-store';
import type { SignalSystem } from '@/components/signal/signal-system';
import { SignalThingsContext, type SignalThingLayer } from '@/components/signal/signal-things';
import { focusOf, topologyOf } from '@/components/signal/signal-topology';

/** How wide a canvas must be for the map, in rems: what SignalWide's and SignalNarrow's container queries say. */
const MAP_WIDTH_REMS = 53;

/** Rems in CSS pixels, at the document's font size, as container queries count them. */
function remsInPixels(rems: number): number {
  return rems * Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
}

// The signal view: an organisation's channels, broadcasts and sources, and how the signal runs between them. This is
// its root and what goes around the map or the stack; they and their parts go inside and read what they need from it.
// It only shows: anything a page lets people do to the system (editing, say) is a layer of its own, composed in.

export interface SignalProps {
  /** What to draw. */
  system: SignalSystem;
  /** What's open to begin with: a network, then a subgroup in it. */
  defaultOpen?: string[];
  children: ReactNode;
}

/**
 * The view's root. It keeps how the view is being looked at (what's open, what's picked), works out what's wired to
 * what from the system and what's open, once, and gives both to everything inside.
 */
export const Signal: FC<SignalProps> = ({ system, defaultOpen = [], children }) => {
  const store = useStore(signalStoreConfig(defaultOpen));
  const open = useSelector(store, snapshot => snapshot.context.open);
  const picked = useSelector(store, snapshot => snapshot.context.picked);
  const topology = topologyOf(system, open);
  const focus = focusOf(topology, picked);
  return (
    <SignalStoreContext value={store}>
      <SignalTopologyContext value={topology}>
        <SignalFocusContext value={focus}>{children}</SignalFocusContext>
      </SignalTopologyContext>
    </SignalStoreContext>
  );
};

export interface SignalThingsProps {
  /** What a thing gets inside, given what it would get without this (signal-things.ts). */
  props: SignalThingLayer;
  children: ReactNode;
}

/**
 * Composes behaviour onto every thing on the view inside it (a channel, a broadcast, a source), over whatever's
 * composed outside it: what a press does, what a hover does. With none, a press picks.
 */
export const SignalThings: FC<SignalThingsProps> = ({ props, children }) => {
  const outer = use(SignalThingsContext);
  return <SignalThingsContext value={[...outer, props]}>{children}</SignalThingsContext>;
};

/** How many things need looking at, for beside a title; it swaps as that changes. */
export const SignalAttention: FC = () => {
  const topology = useSignalTopology();
  const count = topology.attention;
  return (
    <Swap id={String(count)}>
      <Badge variant={count > 0 ? 'destructive' : 'secondary'}>
        {count > 0 ? `${String(count)} need${count === 1 ? 's' : ''} attention` : 'All healthy'}
      </Badge>
    </Swap>
  );
};

export interface SignalCanvasProps extends ComponentProps<'div'> {}

/**
 * Where the map or the stack goes. A press on the empty page lets go of the pick. It is the container SignalWide and
 * SignalNarrow measure, so what goes in it can choose by the room it has rather than by the window, and it tells the
 * view the same (useSignalLayout), for what follows the layout outside it.
 */
export const SignalCanvas: FC<SignalCanvasProps> = ({ className, ...props }) => {
  const store = useSignalStore();
  const measured = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const canvas = measured.current;
    if (!canvas) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      store.trigger.measure({ wide: entry.contentRect.width >= remsInPixels(MAP_WIDTH_REMS) });
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [store]);
  return (
    <div
      ref={measured}
      className={cn('@container/signal flex-1 px-4 py-6 lg:px-8 lg:py-8', className)}
      onClick={() => store.trigger.release()}
      {...props}
    />
  );
};

// What a canvas holds when it has room for the map, and when it doesn't: 53rem across (MAP_WIDTH_REMS, which the
// container queries below spell out). Both stay drawn, one hidden, so moving between them keeps what's open and
// picked; the map measures its links again as it's shown.

export interface SignalWideProps extends ComponentProps<'div'> {}

/** Shown while the canvas is wide enough for the map. */
export const SignalWide: FC<SignalWideProps> = ({ className, ...props }) => {
  return <div className={cn('@max-[53rem]/signal:hidden', className)} {...props} />;
};

export interface SignalNarrowProps extends ComponentProps<'div'> {}

/** Shown while the canvas is too narrow for the map. */
export const SignalNarrow: FC<SignalNarrowProps> = ({ className, ...props }) => {
  return <div className={cn('@min-[53rem]/signal:hidden', className)} {...props} />;
};

export interface SignalHintProps {
  /** What it says; a change of words swaps in place. */
  children: string;
}

/** A line under the view saying what a press does. */
export const SignalHint: FC<SignalHintProps> = ({ children }) => {
  return (
    <p className="mt-6 text-custom-11 text-muted-foreground">
      <Swap id={children}>{children}</Swap>
    </p>
  );
};
