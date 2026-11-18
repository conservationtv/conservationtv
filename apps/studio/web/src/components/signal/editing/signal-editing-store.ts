import { createContext, use } from 'react';
import { createStore, type StoreFromStoreConfig } from '@xstate/store';
import { useSelector } from '@xstate/store-react';

import type { SignalThing } from '@/components/signal/signal-things';

// Editing the signal: a layer on top of the view, and none of the view's business. A page that wants it wraps its
// view in <SignalEditing> and sets the editing parts where it wants them (signal-editing.tsx); the view's own parts
// and its store know nothing of it. Without <SignalEditing> above them the editing parts do nothing and show nothing,
// so the same composition of a view reads either way.

/** Something there is, by what it is and which. */
interface ExistingTarget<Kind extends string> {
  kind: Kind;
  id: string;
}

/** Something to add. */
interface NewTarget<Kind extends string> {
  kind: Kind;
}

/** A camera to add to a network. */
interface NewCameraTarget {
  kind: 'add-camera';
  network: string;
}

/** What can be edited, or added: anything on the view, the groups it's in, or something new. */
export type SignalTarget =
  | SignalThing
  | ExistingTarget<'network'>
  | ExistingTarget<'subgroup'>
  | NewTarget<'add-channel'>
  | NewTarget<'add-broadcast'>
  | NewTarget<'add-source'>
  | NewTarget<'add-network'>
  | NewTarget<'add-ingest'>
  | NewCameraTarget;

/** A target as one word: the same for the same thing, different for any other. */
export const targetKey = (target: SignalTarget) => `${target.kind}-${'id' in target ? target.id : ''}`;

interface SignalEditingState {
  /** The page is being edited: pressing a thing edits it, and the ways to add things are there. */
  editing: boolean;
  /** What is being edited or added: the last such, kept after it's put away so whatever shows it can leave whole. */
  target: SignalTarget | null;
  /** The target is on show. */
  shown: boolean;
}

interface EditEvent {
  target: SignalTarget;
}

const initial: SignalEditingState = { editing: false, target: null, shown: false };

export const signalEditingStoreConfig = {
  context: initial,
  on: {
    /** Into editing, or out of it. */
    toggle: (state: SignalEditingState): SignalEditingState => ({ ...state, editing: !state.editing }),
    /** Take something up to edit or add; from one target on to the next, when one is already up. */
    edit: (state: SignalEditingState, event: EditEvent): SignalEditingState => ({
      ...state,
      target: event.target,
      shown: true
    }),
    /** Put it away. */
    close: (state: SignalEditingState): SignalEditingState => ({ ...state, shown: false })
  }
};

export type SignalEditingStore = StoreFromStoreConfig<typeof signalEditingStoreConfig>;

/** One store per <SignalEditing>. */
export const SignalEditingContext = createContext<SignalEditingStore | null>(null);

/** Stands in where there is no <SignalEditing>: never editing, and nothing ever sent to it. */
const absent: SignalEditingStore = createStore(signalEditingStoreConfig);

/** The editing store, or nothing where the page has no editing. */
export function useSignalEditingStore(): SignalEditingStore | null {
  return use(SignalEditingContext);
}

/** Whether the page is being edited. Never, where the page has no editing. */
export function useSignalEditing(): boolean {
  const store = use(SignalEditingContext) ?? absent;
  return useSelector(store, snapshot => snapshot.context.editing);
}

/** What's up to be edited or added, and whether it's on show. */
export function useSignalEditTarget() {
  const store = use(SignalEditingContext) ?? absent;
  const target = useSelector(store, snapshot => snapshot.context.target);
  const shown = useSelector(store, snapshot => snapshot.context.shown);
  return { target, shown };
}

/**
 * The target one form is for. The surface gives each form its own, so a form on its way out goes on showing what it
 * showed, whatever has been taken up since.
 */
export const SignalFormTargetContext = createContext<SignalTarget | null>(null);

export function useSignalFormTarget(): SignalTarget | null {
  return use(SignalFormTargetContext);
}
