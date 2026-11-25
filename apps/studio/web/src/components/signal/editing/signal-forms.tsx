import type { FC, ReactNode } from 'react';
import { useStore } from '@xstate/store-react';
import { PlusIcon } from '@phosphor-icons/react';
import { Button } from '@conservationtv/ui/components/button';

import {
  SignalFormsContext,
  signalFormsStoreConfig,
  useOpenSignalForm,
  type SignalTarget
} from '@/components/signal/editing/signal-forms-store';

// The forms' root, and the plain ways to open one: an add row for a map column's foot, an "Add" for a stack tier's
// header. Each is there wherever it's placed; when it shows (all the time, or only while editing) is the page's to
// compose (signal-edit-mode.tsx has the pieces for the latter).

export interface SignalFormsProps {
  children: ReactNode;
}

/** Keeps which form is up. Everything that opens a form, and the surface that shows it, goes inside. */
export const SignalForms: FC<SignalFormsProps> = ({ children }) => {
  const store = useStore(signalFormsStoreConfig);
  return <SignalFormsContext value={store}>{children}</SignalFormsContext>;
};

export interface SignalAddProps {
  target: SignalTarget;
  children: ReactNode;
}

/** A dashed row that opens the form to add something: for a map column's foot. */
export const SignalAdd: FC<SignalAddProps> = ({ target, children }) => {
  const open = useOpenSignalForm();
  return (
    <button
      type="button"
      onClick={() => open(target)}
      className="flex h-9 w-full cursor-pointer items-center gap-2 rounded-lg border border-dashed border-border px-3 text-left text-custom-13 text-muted-foreground [&_svg]:size-4"
    >
      <PlusIcon />
      {children}
    </button>
  );
};

export interface SignalTierAddProps {
  target: SignalTarget;
}

/** A quiet "Add" that opens the form to add something: for a stack tier's header. */
export const SignalTierAdd: FC<SignalTierAddProps> = ({ target }) => {
  const open = useOpenSignalForm();
  return (
    <Button variant="ghost" size="xs" className="text-muted-foreground" onClick={() => open(target)}>
      <PlusIcon />
      Add
    </Button>
  );
};
