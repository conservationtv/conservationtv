import { createContext, use, type FC, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { TrashIcon } from '@phosphor-icons/react';
import { Button } from '@conservationtv/ui/components/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@conservationtv/ui/components/dialog';
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle
} from '@conservationtv/ui/components/sheet';

import { AnimateHeight } from '@/components/common/animate-height';
import {
  SignalFormTargetContext,
  targetKey,
  useSignalForms,
  useSignalFormsState
} from '@/components/signal/editing/signal-forms-store';
import { useSignalLayout } from '@/components/signal/signal-context';
import { spring } from '@/components/signal/signal-motion';

// Where the form that's up shows: a dialog over the map, a sheet up from the foot of the stack; going on from one
// form to the next slides across. And the parts a form is composed from, which come out right for whichever it's in.

type Surface = 'dialog' | 'sheet';

const SurfaceContext = createContext<Surface>('dialog');

/** Going on from one form to the next: the old is out of the way before the new one comes across. */
const across = {
  initial: { opacity: 0, x: 24 },
  animate: { opacity: 1, x: 0, transition: { duration: 0.28, delay: 0.09, ease: [0.2, 0, 0, 1] } },
  exit: { opacity: 0, x: -24, transition: { duration: 0.12, ease: 'easeIn' } }
} as const;

export interface SignalFormSurfaceProps {
  /** The form for the target: SignalEditForms, or a page's own. */
  children: ReactNode;
}

/**
 * Shows the form that's up, and puts it away when it's closed. The form stays drawn while it leaves:
 * the target is kept until the next one.
 */
export const SignalFormSurface: FC<SignalFormSurfaceProps> = ({ children }) => {
  const store = useSignalForms();
  const { target, shown } = useSignalFormsState();
  const layout = useSignalLayout();
  const onOpenChange = (open: boolean) => {
    if (!open) store.trigger.close();
  };
  const step = target === null ? '' : targetKey(target);
  if (layout === 'map') {
    return (
      <SurfaceContext value="dialog">
        <Dialog open={shown} onOpenChange={onOpenChange}>
          <DialogContent className="block overflow-hidden p-0 sm:max-w-md">
            {target !== null && (
              // The dialog eases to each form's height as one takes over from another.
              <AnimateHeight transition={spring}>
                <div className="relative">
                  <AnimatePresence mode="popLayout" initial={false}>
                    <motion.div key={step} className="grid gap-4 p-4" {...across}>
                      <SignalFormTargetContext value={target}>{children}</SignalFormTargetContext>
                    </motion.div>
                  </AnimatePresence>
                </div>
              </AnimateHeight>
            )}
          </DialogContent>
        </Dialog>
      </SurfaceContext>
    );
  }
  return (
    <SurfaceContext value="sheet">
      <Sheet open={shown} onOpenChange={onOpenChange}>
        <SheetContent side="bottom" className="max-h-[88svh] overflow-hidden rounded-t-2xl">
          {target !== null && (
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.div key={step} className="flex min-h-0 flex-1 flex-col" {...across}>
                <div className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-border" />
                <SignalFormTargetContext value={target}>{children}</SignalFormTargetContext>
              </motion.div>
            </AnimatePresence>
          )}
        </SheetContent>
      </Sheet>
    </SurfaceContext>
  );
};

interface PartProps {
  children: ReactNode;
}

/** The form's title and the line under it. */
export const SignalFormHeader: FC<PartProps> = ({ children }) => {
  const surface = use(SurfaceContext);
  if (surface === 'dialog') return <DialogHeader>{children}</DialogHeader>;
  return <SheetHeader className="pb-2">{children}</SheetHeader>;
};

export const SignalFormTitle: FC<PartProps> = ({ children }) => {
  const surface = use(SurfaceContext);
  if (surface === 'dialog') return <DialogTitle>{children}</DialogTitle>;
  return <SheetTitle>{children}</SheetTitle>;
};

/** What the thing is, or what the form is for; it can hold more than words. */
export const SignalFormDescription: FC<PartProps> = ({ children }) => {
  const surface = use(SurfaceContext);
  if (surface === 'dialog') return <DialogDescription render={<div />}>{children}</DialogDescription>;
  return <SheetDescription render={<div />}>{children}</SheetDescription>;
};

/** The form's fields; in a sheet they scroll under its header when there are too many. */
export const SignalFormBody: FC<PartProps> = ({ children }) => {
  const surface = use(SurfaceContext);
  if (surface === 'dialog') return <div className="text-custom-13">{children}</div>;
  return <div className="min-h-0 flex-1 overflow-auto px-4 pb-4 text-custom-13">{children}</div>;
};

/** The form's actions, at its foot. */
export const SignalFormFooter: FC<PartProps> = ({ children }) => {
  const surface = use(SurfaceContext);
  if (surface === 'dialog') {
    return <div className="-mx-4 -mb-4 flex items-center justify-end gap-2 border-t bg-muted/50 p-3">{children}</div>;
  }
  return (
    <div className="flex items-center justify-end gap-2 border-t px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
      {children}
    </div>
  );
};

/** Removes the thing, at the footer's start. */
export const SignalFormRemove: FC = () => {
  const store = useSignalForms();
  return (
    <Button variant="ghost" size="sm" className="mr-auto text-destructive" onClick={() => store.trigger.close()}>
      <TrashIcon />
      Remove
    </Button>
  );
};

/** In place of Cancel, at the footer's start: what the form is waiting for. */
export const SignalFormWaiting: FC<PartProps> = ({ children }) => {
  return <span className="mr-auto">{children}</span>;
};

export const SignalFormCancel: FC = () => {
  const surface = use(SurfaceContext);
  const Close = surface === 'dialog' ? DialogClose : SheetClose;
  return <Close render={<Button variant="ghost" size="sm" />}>Cancel</Close>;
};

/** The form's main button; it closes the form. */
export const SignalFormSubmit: FC<PartProps> = ({ children }) => {
  const surface = use(SurfaceContext);
  const Close = surface === 'dialog' ? DialogClose : SheetClose;
  return <Close render={<Button size="sm" />}>{children}</Close>;
};
