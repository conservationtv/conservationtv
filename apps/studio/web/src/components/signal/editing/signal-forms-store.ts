import { createContext, use } from 'react';
import type { StoreFromStoreConfig } from '@xstate/store';
import { useSelector } from '@xstate/store-react';

import type { SignalThing } from '@/components/signal/signal-things';

// The signal's forms: which one is up, and whether it's on show. A layer of its own, on top of the view and none of its
// business: a page that wants forms wraps its view in <SignalForms> (signal-forms.tsx), sets a <SignalFormSurface>
// where they show, and places whatever opens them (an add row, the edit mode's press) where it wants. It knows nothing
// of editing as a mode: opening a form is all anything asks of it.

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

/** What a form can be for: anything on the view, the groups it's in, or something new. */
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

interface SignalFormsState {
  /** The form that's up: the last one, kept after it's put away so whatever shows it can leave whole. */
  target: SignalTarget | null;
  /** It is on show. */
  shown: boolean;
}

interface OpenEvent {
  target: SignalTarget;
}

const initial: SignalFormsState = { target: null, shown: false };

export const signalFormsStoreConfig = {
  context: initial,
  on: {
    /** Put a form up; from one on to the next, when one is already up. */
    open: (state: SignalFormsState, event: OpenEvent): SignalFormsState => ({
      ...state,
      target: event.target,
      shown: true
    }),
    /** Put it away. */
    close: (state: SignalFormsState): SignalFormsState => ({ ...state, shown: false })
  }
};

export type SignalFormsStore = StoreFromStoreConfig<typeof signalFormsStoreConfig>;

/** One store per <SignalForms>. */
export const SignalFormsContext = createContext<SignalFormsStore | null>(null);

/** The forms' store. Anything that opens or shows a form is placed under <SignalForms>, so there always is one. */
export function useSignalForms(): SignalFormsStore {
  const store = use(SignalFormsContext);
  if (!store) throw new Error('A signal form part is outside <SignalForms>');
  return store;
}

/** Puts up the form for a target. */
export function useOpenSignalForm(): (target: SignalTarget) => void {
  const store = useSignalForms();
  return target => store.trigger.open({ target });
}

/** The form that's up, and whether it's on show. */
export function useSignalFormsState(): SignalFormsState {
  const store = useSignalForms();
  const target = useSelector(store, snapshot => snapshot.context.target);
  const shown = useSelector(store, snapshot => snapshot.context.shown);
  return { target, shown };
}

/**
 * The target one form is for. The surface gives each form its own, so a form on its way out goes on showing what it
 * showed, whatever has been put up since.
 */
export const SignalFormTargetContext = createContext<SignalTarget | null>(null);

export function useSignalFormTarget(): SignalTarget | null {
  return use(SignalFormTargetContext);
}
