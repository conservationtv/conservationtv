import type { FC, ReactNode } from 'react';
import { AnimatePresence, motion, type MotionProps } from 'motion/react';
import { CaretRightIcon } from '@phosphor-icons/react';
import { cn } from '@conservationtv/ui/lib/utils';

import { quick, spring } from '@/components/signal/signal-motion';

// The few ways things come, go and change on the signal view, so the same few movements are used everywhere. Each is
// still on first draw: it moves only when what it holds changes.

type SwapMotion = Pick<MotionProps, 'initial' | 'animate' | 'exit' | 'transition'>;

const swaps = {
  /** Words: the old slips up and out as the new comes up from under. */
  slide: {
    initial: { opacity: 0, y: 5, filter: 'blur(3px)' },
    // The old is nearly gone before the new arrives, so the two are never both legible.
    animate: { opacity: 1, y: 0, filter: 'blur(0px)', transition: { ...quick, delay: 0.07 } },
    exit: { opacity: 0, y: -5, filter: 'blur(3px)', transition: { duration: 0.11, ease: 'easeIn' } },
    transition: quick
  },
  /** A health dot changing: it pops, so a change of state catches the eye once. */
  pop: {
    initial: { opacity: 0, scale: 0.3 },
    animate: { opacity: 1, scale: 1 },
    exit: { opacity: 0, scale: 0.3 },
    transition: { type: 'spring', duration: 0.45, bounce: 0.5 }
  }
} satisfies Record<string, SwapMotion>;

export interface SwapProps {
  /** What it holds, named: a change of name is what swaps. */
  id: string;
  kind?: keyof typeof swaps;
  className?: string;
  children: ReactNode;
}

/** Whatever it holds, swapped in place whenever `id` changes. */
export const Swap: FC<SwapProps> = ({ id, kind = 'slide', className, children }) => {
  return (
    <span className={cn('relative inline-flex min-w-0', className)}>
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span key={id} className="inline-flex min-w-0 items-center gap-[inherit]" {...swaps[kind]}>
          {children}
        </motion.span>
      </AnimatePresence>
    </span>
  );
};

export interface PresenceProps {
  when: boolean;
  className?: string;
  children: ReactNode;
}

/** Something that comes and goes without moving what's around it: it fades and grows a touch. */
export const Appear: FC<PresenceProps> = ({ when, className, children }) => {
  return (
    <AnimatePresence mode="popLayout" initial={false}>
      {when && (
        <motion.span
          key="shown"
          className={cn('inline-flex items-center', className)}
          initial={{ opacity: 0, scale: 0.85 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.85 }}
          transition={quick}
        >
          {children}
        </motion.span>
      )}
    </AnimatePresence>
  );
};

export interface RevealProps extends PresenceProps {
  /** The gap of the stack it's in, in pixels: taken back while it's shut, so nothing jumps as it arrives or leaves. */
  gap?: number;
}

/** Something that comes and goes in a stack, making room for itself: its height opens. */
export const Reveal: FC<RevealProps> = ({ when, gap = 0, className, children }) => {
  return (
    <AnimatePresence initial={false}>
      {when && (
        <motion.div
          key="revealed"
          className={className}
          style={{ overflow: 'clip' }}
          initial={{ height: 0, opacity: 0, marginTop: -gap }}
          animate={{ height: 'auto', opacity: 1, marginTop: 0 }}
          exit={{ height: 0, opacity: 0, marginTop: -gap }}
          transition={spring}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
};

/** A small control that tucks in at a row's end, widening to make its own room. */
export const Tuck: FC<PresenceProps> = ({ when, className, children }) => {
  return (
    <AnimatePresence initial={false}>
      {when && (
        <motion.span
          key="tucked"
          className={cn('inline-flex shrink-0 items-center justify-end', className)}
          initial={{ width: 0, opacity: 0, scale: 0.6 }}
          animate={{ width: 'auto', opacity: 1, scale: 1 }}
          exit={{ width: 0, opacity: 0, scale: 0.6 }}
          transition={spring}
        >
          {children}
        </motion.span>
      )}
    </AnimatePresence>
  );
};

export interface CaretProps {
  open: boolean;
}

/** A group's caret: one arrow that turns, rather than two that swap. */
export const Caret: FC<CaretProps> = ({ open }) => {
  return (
    <motion.span
      className="flex shrink-0 text-muted-foreground"
      initial={false}
      animate={{ rotate: open ? 90 : 0 }}
      transition={spring}
    >
      <CaretRightIcon className="size-3" />
    </motion.span>
  );
};
