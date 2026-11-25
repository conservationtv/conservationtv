import { createContext, use } from 'react';
import type { StoreFromStoreConfig } from '@xstate/store';
import { useSelector } from '@xstate/store-react';

// Whether the page is being edited: the edit mode's store, for its parts in signal-edit-mode.tsx.

interface SignalEditModeState {
  editing: boolean;
}

const initial: SignalEditModeState = { editing: false };

export const signalEditModeStoreConfig = {
  context: initial,
  on: {
    /** Into editing, or out of it. */
    toggle: (state: SignalEditModeState): SignalEditModeState => ({ editing: !state.editing })
  }
};

type SignalEditModeStore = StoreFromStoreConfig<typeof signalEditModeStoreConfig>;

export const SignalEditModeContext = createContext<SignalEditModeStore | null>(null);

export function useSignalEditModeStore(): SignalEditModeStore {
  const store = use(SignalEditModeContext);
  if (!store) throw new Error('A signal edit mode part is outside <SignalEditMode>');
  return store;
}

/** Whether the page is being edited. */
export function useSignalEditing(): boolean {
  const store = useSignalEditModeStore();
  return useSelector(store, snapshot => snapshot.context.editing);
}
