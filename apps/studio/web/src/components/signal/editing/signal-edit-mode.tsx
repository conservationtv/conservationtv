import { use, type FC, type ReactNode } from 'react';
import { useStore } from '@xstate/store-react';
import { AnimatePresence, motion } from 'motion/react';
import { PencilSimpleIcon } from '@phosphor-icons/react';
import { Button } from '@conservationtv/ui/components/button';
import { cn } from '@conservationtv/ui/lib/utils';

import {
  SignalEditModeContext,
  signalEditModeStoreConfig,
  useSignalEditing,
  useSignalEditModeStore
} from '@/components/signal/editing/signal-edit-mode-store';
import { useOpenSignalForm } from '@/components/signal/editing/signal-forms-store';
import { SignalThings } from '@/components/signal/signal';
import { SignalStoreContext, useSignalColumnGap } from '@/components/signal/signal-context';
import { spring } from '@/components/signal/signal-motion';
import { Appear, Reveal, Swap } from '@/components/signal/signal-presence';

// Editing as a mode: a page that's read until it's switched into editing. A layer of its own, and only that: whether
// the page is being edited, the control that switches it, and pieces that show what they hold only while it is. What
// shows while editing, and where, is the page's to compose; so is what a press does then (<SignalEditPress>, which
// opens a thing's form, is one choice). Forms are their own layer (signal-forms.tsx), which this knows nothing of
// except through <SignalEditPress>.

export interface SignalEditModeProps {
  children: ReactNode;
}

/** Keeps whether the page is being edited, for everything of the mode's inside. */
export const SignalEditMode: FC<SignalEditModeProps> = ({ children }) => {
  const store = useStore(signalEditModeStoreConfig);
  return <SignalEditModeContext value={store}>{children}</SignalEditModeContext>;
};

/**
 * Switches editing on and off. One control that grows a label when editing, rather than two that swap. Going either
 * way lets go of whatever is picked on the view.
 */
export const SignalEditToggle: FC = () => {
  const store = useSignalEditModeStore();
  const signal = use(SignalStoreContext);
  const editing = useSignalEditing();
  const toggle = () => {
    store.trigger.toggle();
    signal?.trigger.release();
  };
  return (
    <div
      className={cn(
        'flex items-center rounded-lg border p-1 transition-colors duration-300',
        editing ? 'border-border bg-popover' : 'border-transparent'
      )}
    >
      <AnimatePresence initial={false}>
        {editing && (
          <motion.span
            key="editing"
            className="flex overflow-hidden whitespace-nowrap"
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: 'auto', opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={spring}
          >
            <span className="flex items-center gap-1.5 px-2 text-custom-12 text-muted-foreground">
              <PencilSimpleIcon />
              Editing
            </span>
          </motion.span>
        )}
      </AnimatePresence>
      <Button variant={editing ? 'default' : 'outline'} size="sm" onClick={toggle}>
        <Swap id={editing ? 'done' : 'edit'} className="gap-1.5">
          {editing ? (
            'Done'
          ) : (
            <>
              <PencilSimpleIcon />
              Edit
            </>
          )}
        </Swap>
      </Button>
    </div>
  );
};

export interface WhileEditingProps {
  children: ReactNode;
}

/** What it holds, only while editing, making room for itself in the map column it's in: for a column's foot. */
export const SignalRevealWhileEditing: FC<WhileEditingProps> = ({ children }) => {
  const editing = useSignalEditing();
  const gap = useSignalColumnGap();
  return (
    <Reveal when={editing} gap={gap}>
      {children}
    </Reveal>
  );
};

/** What it holds, only while editing, without moving what's around it: for a stack tier's header. */
export const SignalAppearWhileEditing: FC<WhileEditingProps> = ({ children }) => {
  const editing = useSignalEditing();
  return <Appear when={editing}>{children}</Appear>;
};

export interface SignalEditPressProps {
  children: ReactNode;
}

/**
 * While editing, pressing a thing on the view opens its form, in place of whatever a press did; otherwise a press does
 * what it did. Composed onto the things like any page's behaviour (<SignalThings>), inside <SignalEditMode> and
 * <SignalForms>.
 */
export const SignalEditPress: FC<SignalEditPressProps> = ({ children }) => {
  const editing = useSignalEditing();
  const open = useOpenSignalForm();
  return (
    <SignalThings props={(thing, inherited) => (editing ? { onClick: () => open(thing) } : inherited)}>
      {children}
    </SignalThings>
  );
};
