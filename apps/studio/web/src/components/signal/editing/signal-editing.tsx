import { use, type ComponentProps, type FC, type MouseEvent, type ReactNode } from 'react';
import { useStore } from '@xstate/store-react';
import { AnimatePresence, motion } from 'motion/react';
import { CaretRightIcon, DotsThreeIcon, PencilSimpleIcon, PlusIcon } from '@phosphor-icons/react';
import { Button } from '@conservationtv/ui/components/button';
import { cn } from '@conservationtv/ui/lib/utils';

import {
  SignalEditingContext,
  signalEditingStoreConfig,
  useSignalEditing,
  useSignalEditingStore,
  type SignalTarget
} from '@/components/signal/editing/signal-editing-store';
import { SignalStoreContext, useSignalColumnGap } from '@/components/signal/signal-context';
import { spring } from '@/components/signal/signal-motion';
import { Appear, Reveal, Swap, Tuck } from '@/components/signal/signal-presence';
import { SignalThings } from '@/components/signal/signal';

// Editing's parts, to set among a signal view's own: the control that turns editing on, and what it brings while
// it's on (a press that edits instead of picking, a "more" button on a label, a dashed row to add by). None of them
// does or shows anything until the page is being edited, nor anywhere there's no <SignalEditing> above it. The press
// is composed onto the view's things like any page's behaviour (<SignalThings>), so the view knows nothing of it.

export interface SignalEditingProps {
  children: ReactNode;
}

/**
 * Makes what's inside editable: it keeps whether the page is being edited, and what's been taken up to edit; and while
 * it's being edited, pressing a thing on the view edits it, in place of whatever a press did.
 */
export const SignalEditing: FC<SignalEditingProps> = ({ children }) => {
  const store = useStore(signalEditingStoreConfig);
  return (
    <SignalEditingContext value={store}>
      <EditingPress>{children}</EditingPress>
    </SignalEditingContext>
  );
};

const EditingPress: FC<SignalEditingProps> = ({ children }) => {
  const editing = useSignalEditing();
  const edit = useEdit();
  return (
    <SignalThings props={(thing, inherited) => (editing ? { onClick: () => edit(thing) } : inherited)}>
      {children}
    </SignalThings>
  );
};

/** Takes a target up to edit or add. */
function useEdit() {
  const store = useSignalEditingStore();
  return (target: SignalTarget) => store?.trigger.edit({ target });
}

/**
 * Turns editing on and off. One control that grows a label when editing, rather than two that swap. Going either way
 * lets go of whatever is picked on the view.
 */
export const SignalEditToggle: FC = () => {
  const store = useSignalEditingStore();
  const signal = use(SignalStoreContext);
  const editing = useSignalEditing();
  if (!store) return null;
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

export interface SignalEditActionProps extends ComponentProps<typeof Button> {
  target: SignalTarget;
  /** For the place it tucks into: its margins there. */
  className?: string;
}

/**
 * A "more" button for something whose press already does something else (a label that opens its group). It tucks in
 * at the row's end while editing, widening to make its own room.
 */
export const SignalEditAction: FC<SignalEditActionProps> = ({ target, className, ...props }) => {
  const editing = useSignalEditing();
  const edit = useEdit();
  // Its press is its own: the row it sits in isn't pressed too.
  const onClick = (event: MouseEvent) => {
    event.stopPropagation();
    edit(target);
  };
  return (
    <Tuck when={editing} className={className}>
      <Button variant="ghost" size="icon-xs" aria-label="More" onClick={onClick} {...props}>
        <DotsThreeIcon weight="bold" />
      </Button>
    </Tuck>
  );
};

export interface SignalAddProps {
  target: SignalTarget;
  children: ReactNode;
}

/** A dashed "add" at the foot of a map column, there while editing; it makes room for itself as it arrives. */
export const SignalAdd: FC<SignalAddProps> = ({ target, children }) => {
  const editing = useSignalEditing();
  const edit = useEdit();
  const gap = useSignalColumnGap();
  return (
    <Reveal when={editing} gap={gap}>
      <button
        type="button"
        onClick={() => edit(target)}
        className="flex h-9 w-full cursor-pointer items-center gap-2 rounded-lg border border-dashed border-border px-3 text-left text-custom-13 text-muted-foreground [&_svg]:size-4"
      >
        <PlusIcon />
        {children}
      </button>
    </Reveal>
  );
};

export interface SignalTierAddProps {
  target: SignalTarget;
}

/** A quiet "Add" at the end of a stack tier's header, there while editing. */
export const SignalTierAdd: FC<SignalTierAddProps> = ({ target }) => {
  const editing = useSignalEditing();
  const edit = useEdit();
  return (
    <Appear when={editing} className="ml-auto">
      <Button variant="ghost" size="xs" className="text-muted-foreground" onClick={() => edit(target)}>
        <PlusIcon />
        Add
      </Button>
    </Appear>
  );
};

export interface SignalEditChevronProps {
  /** What's at the row's end the rest of the time: its health. */
  children: ReactNode;
}

/** A stack row's end: a chevron while editing, saying a press goes somewhere; otherwise whatever it holds. */
export const SignalEditChevron: FC<SignalEditChevronProps> = ({ children }) => {
  const editing = useSignalEditing();
  return (
    <Swap id={editing ? 'editing' : 'health'} className="gap-2">
      {editing ? <CaretRightIcon /> : children}
    </Swap>
  );
};
