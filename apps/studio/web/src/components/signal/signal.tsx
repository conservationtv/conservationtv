import type { ComponentProps, FC, ReactNode } from 'react';
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
import { focusOf, topologyOf } from '@/components/signal/signal-topology';

// The signal view: an organisation's channels, broadcasts and sources, and how the signal runs between them. This is
// its root and the page's furniture; the map, the stack and their parts go inside and read what they need from it.
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

export interface SignalHeaderProps extends ComponentProps<'header'> {}

/** The page's header, kept in view: its title, and whatever controls the page has. */
export const SignalHeader: FC<SignalHeaderProps> = ({ className, ...props }) => {
  return (
    <header
      className={cn(
        'sticky top-0 z-40 flex flex-wrap items-center gap-x-3 gap-y-2 border-b bg-background/90 px-4 py-3 backdrop-blur lg:px-8',
        className
      )}
      {...props}
    />
  );
};

export interface SignalHeaderTextProps extends ComponentProps<'div'> {}

/** The title and a line under it; it takes the header's whole width on a phone, pushing the controls below. */
export const SignalHeaderText: FC<SignalHeaderTextProps> = ({ className, ...props }) => {
  return <div className={cn('flex w-full min-w-0 flex-col sm:w-auto sm:flex-1', className)} {...props} />;
};

export interface SignalTitleProps extends ComponentProps<'h1'> {}

export const SignalTitle: FC<SignalTitleProps> = ({ className, ...props }) => {
  return <h1 className={cn('flex items-center gap-2 text-custom-15 font-semibold', className)} {...props} />;
};

/** How many things need looking at, beside the title; it swaps as that changes. */
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

/** Where the map or the stack goes. A press on the empty page lets go of the pick. */
export const SignalCanvas: FC<SignalCanvasProps> = ({ className, ...props }) => {
  const store = useSignalStore();
  return (
    <div
      className={cn('flex-1 px-4 py-6 lg:px-8 lg:py-8', className)}
      onClick={() => store.trigger.release()}
      {...props}
    />
  );
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
