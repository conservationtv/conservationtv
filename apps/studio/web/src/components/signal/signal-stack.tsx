import type { ComponentProps, FC, ReactNode } from 'react';
import { motion, type HTMLMotionProps } from 'motion/react';
import { cn } from '@conservationtv/ui/lib/utils';

import { SignalItemContext, useSignalItem, useSignalStanding } from '@/components/signal/signal-context';
import { drawing, item } from '@/components/signal/signal-motion';
import { PRESSABLE, pressable } from '@/components/signal/signal-press';

// The signal map top to bottom, with no graph, for where there's no room for one: the audience's channels at the
// top, the broadcasts under them, the sources at the foot. Each tier is one surface of rows, one line each, with a
// single health signal at the row's end.

export interface SignalStackProps extends HTMLMotionProps<'div'> {
  children?: ReactNode;
}

/** The tiers, top to bottom; on first draw they come up into place one after another. */
export const SignalStack: FC<SignalStackProps> = ({ className, children, ...props }) => {
  return (
    <SignalItemContext value>
      <motion.div
        className={cn('@container flex flex-col gap-3', className)}
        variants={drawing(0, 2)}
        initial="before"
        animate="drawn"
        {...props}
      >
        {children}
      </motion.div>
    </SignalItemContext>
  );
};

export interface SignalTierProps extends HTMLMotionProps<'section'> {
  children?: ReactNode;
}

/** One tier: channels, broadcasts or sources. */
export const SignalTier: FC<SignalTierProps> = ({ className, children, ...props }) => {
  const isItem = useSignalItem();
  return (
    <SignalItemContext value={false}>
      <motion.section variants={isItem ? item : undefined} className={cn('flex flex-col gap-2', className)} {...props}>
        {children}
      </motion.section>
    </SignalItemContext>
  );
};

export interface SignalTierHeaderProps extends ComponentProps<'header'> {}

/** The tier's label; anything else (an add button) goes at its end. */
export const SignalTierHeader: FC<SignalTierHeaderProps> = ({ className, ...props }) => {
  return <header className={cn('flex min-h-6 items-center gap-1.5', className)} {...props} />;
};

export interface SignalTierTitleProps extends ComponentProps<'h3'> {}

export const SignalTierTitle: FC<SignalTierTitleProps> = ({ className, ...props }) => {
  return (
    <h3
      className={cn(
        'text-custom-10 font-semibold tracking-(--tracking-custom-label) text-muted-foreground uppercase',
        className
      )}
      {...props}
    />
  );
};

export interface SignalListProps extends ComponentProps<'div'> {}

/** A tier's rows in one surface, hairlines between. */
export const SignalList: FC<SignalListProps> = ({ className, ...props }) => {
  return (
    <div
      className={cn(
        'grid grid-cols-1 gap-px overflow-hidden rounded-xl border border-border bg-border [&>*]:min-w-0 [&>*]:bg-card',
        className
      )}
      {...props}
    />
  );
};

export interface SignalListItemProps extends ComponentProps<'div'> {
  /** What it is on the signal path: it's tinted when picked, and fades when something off its path is. */
  id?: string;
  children?: ReactNode;
}

/**
 * One row: an icon, a name (and, only when something needs saying, a second line), its health at the end. One of an
 * opened group's rows comes in with its siblings. It's an element like any other: given an `onClick`, it's pressable.
 */
export const SignalListItem: FC<SignalListItemProps> = ({ id, onClick, onKeyDown, className, ...props }) => {
  const standing = useSignalStanding(id);
  const isItem = useSignalItem();
  const pressing = pressable(onClick, onKeyDown);
  const row = (
    <SignalItemContext value={false}>
      <div
        data-picked={standing.picked || undefined}
        className={cn(
          'flex min-h-11 items-center gap-3 px-3 py-2 text-custom-13 [&>*]:transition-opacity [&>[aria-hidden]]:text-muted-foreground',
          standing.picked && '!bg-muted',
          // The row's contents fade, not the row, so the surface stays opaque over the hairlines behind it.
          standing.dimmed && '[&>*]:opacity-35',
          className,
          onClick && PRESSABLE,
          'transition-colors duration-200'
        )}
        // Its own handlers are in `pressing`; what else it's given (a link's role, say) has the last word.
        {...pressing}
        {...props}
      />
    </SignalItemContext>
  );
  return isItem ? <motion.div variants={item}>{row}</motion.div> : row;
};

export interface SignalListIconProps extends ComponentProps<'span'> {}

/** A member row's icon, a size down from a tier's own rows'. */
export const SignalListIcon: FC<SignalListIconProps> = ({ className, ...props }) => {
  return <span aria-hidden className={cn('[&_svg]:size-3.5', className)} {...props} />;
};

export interface SignalListTextProps extends ComponentProps<'div'> {}

/** The row's name and its second line. */
export const SignalListText: FC<SignalListTextProps> = ({ className, ...props }) => {
  return <div className={cn('flex min-w-0 flex-1 flex-col', className)} {...props} />;
};

export interface SignalListNoteProps extends ComponentProps<'span'> {
  tone?: 'default' | 'destructive' | 'warning';
}

const noteTones = {
  default: 'text-muted-foreground',
  destructive: 'text-destructive',
  warning: 'text-custom-warning'
};

/** The second line: said only when there's something to say. */
export const SignalListNote: FC<SignalListNoteProps> = ({ tone = 'default', className, ...props }) => {
  return <span className={cn('truncate text-custom-12', noteTones[tone], className)} {...props} />;
};

export interface SignalListTrailProps extends ComponentProps<'div'> {}

/** The row's end: its health. */
export const SignalListTrail: FC<SignalListTrailProps> = ({ className, ...props }) => {
  return (
    <div
      className={cn(
        'ml-auto flex shrink-0 items-center gap-2 text-custom-12 text-muted-foreground [&_svg]:size-3.5',
        className
      )}
      {...props}
    />
  );
};
