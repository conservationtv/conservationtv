import type { ComponentProps, FC, ReactNode } from 'react';
import { ArrowUpIcon, CheckIcon, PlusIcon, XIcon } from '@phosphor-icons/react';
import { cn } from '@conservationtv/ui/lib/utils';

import { SignalHealthDot, type SignalStatus } from '@/components/overview/signal-map';

// The signal map top to bottom, with no graph: the audience's channels at the top, the broadcasts under them, the
// sources at the foot, each a tier of cards that reflows with the space it has. Wires become routes: chips on a card
// naming what it takes from, or sends to, in the tier next to it. Works from a phone to a wide screen.

export interface SignalStackProps extends ComponentProps<'div'> {}

/** The tiers, top to bottom; their grids reflow by the stack's own width, not the window's. */
export const SignalStack: FC<SignalStackProps> = ({ className, ...props }) => {
  return <div className={cn('@container flex flex-col gap-3', className)} {...props} />;
};

export interface SignalTierProps extends ComponentProps<'section'> {}

/** One tier: channels, broadcasts or sources. */
export const SignalTier: FC<SignalTierProps> = ({ className, ...props }) => {
  return <section className={cn('flex flex-col gap-2', className)} {...props} />;
};

export interface SignalTierHeaderProps extends ComponentProps<'header'> {
  count?: number;
  /** A summary of its health, after the count: "1 network down". */
  summary?: ReactNode;
}

/** The tier's label and count; anything else (an add button) goes at its end. */
export const SignalTierHeader: FC<SignalTierHeaderProps> = ({ count, summary, className, children, ...props }) => {
  return (
    <header className={cn('flex min-h-6 items-center gap-1.5', className)} {...props}>
      {children}
      {count !== undefined && <span className="text-custom-10 text-muted-foreground">{count}</span>}
      {summary && <span className="text-custom-11 text-muted-foreground">· {summary}</span>}
    </header>
  );
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

export interface SignalTierActionsProps extends ComponentProps<'div'> {}

export const SignalTierActions: FC<SignalTierActionsProps> = ({ className, ...props }) => {
  return <div className={cn('ml-auto flex items-center gap-1', className)} {...props} />;
};

export interface SignalTierContentProps extends ComponentProps<'div'> {}

/** The tier's cards: one column on a phone; give it more with container breakpoints (`@lg:grid-cols-2`). */
export const SignalTierContent: FC<SignalTierContentProps> = ({ className, ...props }) => {
  return <div className={cn('grid grid-cols-1 items-start gap-2 [&>*]:min-w-0', className)} {...props} />;
};

export interface SignalTierJoinProps extends ComponentProps<'div'> {}

/** Between two tiers: the way the signal goes (up, to the audience), and anything it passes through. */
export const SignalTierJoin: FC<SignalTierJoinProps> = ({ className, children, ...props }) => {
  return (
    <div
      aria-hidden={children === undefined}
      className={cn(
        'flex items-center gap-2 text-custom-11 text-muted-foreground [&_svg]:size-3 [&_svg]:shrink-0',
        className
      )}
      {...props}
    >
      <span className="h-px flex-1 bg-border" />
      <ArrowUpIcon />
      {children}
      <span className="h-px flex-1 bg-border" />
    </div>
  );
};

export interface SignalRoutesProps extends ComponentProps<'div'> {}

/** A card's routes: what it takes from, or sends to, in the next tier. */
export const SignalRoutes: FC<SignalRoutesProps> = ({ className, ...props }) => {
  return <div className={cn('flex flex-wrap items-center gap-1 whitespace-normal', className)} {...props} />;
};

export interface SignalRoutesLabelProps extends ComponentProps<'span'> {}

export const SignalRoutesLabel: FC<SignalRoutesLabelProps> = ({ className, ...props }) => {
  return <span className={cn('mr-0.5 text-custom-11 text-muted-foreground', className)} {...props} />;
};

const routeStates = {
  on: 'border-border bg-background text-foreground',
  off: 'border-dashed border-border text-muted-foreground',
  new: 'border-emerald-500/50 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  removing: 'border-dashed border-destructive/50 text-destructive line-through',
  picked: 'border-ring bg-muted text-foreground ring-1 ring-ring'
};

export interface SignalRouteProps extends ComponentProps<'span'> {
  /** Its health: a dot before the name. */
  status?: SignalStatus;
  state?: keyof typeof routeStates;
}

/** One route: the thing at the other end, named, with its icon and health. */
export const SignalRoute: FC<SignalRouteProps> = ({ status, state = 'on', className, children, ...props }) => {
  return (
    <span
      data-state={state}
      className={cn(
        'inline-flex h-5 max-w-full items-center gap-1 truncate rounded-md border px-1.5 text-custom-11 whitespace-nowrap [&_svg]:size-3 [&_svg]:shrink-0',
        routeStates[state],
        className
      )}
      {...props}
    >
      {status && <SignalHealthDot status={status} />}
      {children}
    </span>
  );
};

export interface SignalRouteToggleProps extends ComponentProps<'button'> {
  /** Routed: a tick, and a cross on hover to cut it. Not: a plus to add it. */
  pressed: boolean;
  state?: keyof typeof routeStates;
}

/** A route while editing: pressed to send there, pressed again to stop. */
export const SignalRouteToggle: FC<SignalRouteToggleProps> = ({ pressed, state, className, children, ...props }) => {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      className={cn(
        'group/route inline-flex h-6 items-center gap-1 rounded-md border px-1.5 text-custom-11 [&_svg]:size-3 [&_svg]:shrink-0',
        routeStates[state ?? (pressed ? 'on' : 'off')],
        className
      )}
      {...props}
    >
      {pressed ? (
        <>
          <CheckIcon className="group-hover/route:hidden" />
          <XIcon className="hidden group-hover/route:block" />
        </>
      ) : (
        <PlusIcon />
      )}
      {children}
    </button>
  );
};

// ---------------------------------------------------------------------------------------------------------------------
// The quiet form: rows in one surface per tier, one line each, a single health signal at the end.

export interface SignalListProps extends ComponentProps<'div'> {}

/** A tier's rows in one surface, hairlines between; give it columns with container breakpoints. */
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
  /** Picked: tinted. Faded: off the picked thing's path. */
  picked?: boolean;
  faded?: boolean;
}

/** One row: an icon, a name (and, only when something needs saying, a second line), its health at the end. */
export const SignalListItem: FC<SignalListItemProps> = ({ picked, faded, className, ...props }) => {
  return (
    <div
      data-picked={picked || undefined}
      className={cn(
        'flex min-h-11 items-center gap-3 px-3 py-2 text-custom-13 [&>*]:transition-opacity [&>[aria-hidden]]:text-muted-foreground',
        picked && '!bg-muted',
        // The row's contents fade, not the row, so the surface stays opaque over the hairlines behind it.
        faded && '[&>*]:opacity-35',
        className
      )}
      {...props}
    />
  );
};

export interface SignalListTextProps extends ComponentProps<'div'> {}

/** The row's name and its second line. */
export const SignalListText: FC<SignalListTextProps> = ({ className, ...props }) => {
  return <div className={cn('flex min-w-0 flex-1 flex-col', className)} {...props} />;
};

export interface SignalListNoteProps extends ComponentProps<'span'> {
  tone?: 'default' | 'destructive' | 'warning';
}

/** The second line: said only when there's something to say. */
export const SignalListNote: FC<SignalListNoteProps> = ({ tone = 'default', className, ...props }) => {
  return (
    <span
      className={cn(
        'truncate text-custom-12',
        tone === 'default' && 'text-muted-foreground',
        tone === 'destructive' && 'text-destructive',
        tone === 'warning' && 'text-custom-warning',
        className
      )}
      {...props}
    />
  );
};

export interface SignalListTrailProps extends ComponentProps<'div'> {}

/** The row's end: its health, a chevron while editing. */
export const SignalListTrail: FC<SignalListTrailProps> = ({ className, ...props }) => {
  return (
    <div
      className={cn('ml-auto flex shrink-0 items-center gap-2 text-custom-12 text-muted-foreground [&_svg]:size-3.5', className)}
      {...props}
    />
  );
};
