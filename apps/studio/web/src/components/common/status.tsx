import type { ComponentProps, FC } from 'react';
import { cn } from '@conservationtv/ui/lib/utils';

// How something is doing, as a dot and a word. The statuses are the stream topology's
// (src/components/streams/topology.ts): what a subject's reports say about it, or a failure upstream of it.

export type Status = 'ok' | 'unknown' | 'degraded' | 'failing' | 'affected' | 'idle' | 'off';

const dotColours = {
  ok: 'bg-emerald-500',
  unknown: 'bg-muted-foreground/40',
  degraded: 'bg-amber-500',
  failing: 'bg-destructive',
  affected: 'bg-destructive/40',
  // Not judged: on with nothing asking for it, or switched off. Neither is a colour of its own, only quieter.
  idle: 'bg-muted-foreground/70',
  off: 'bg-muted-foreground/25'
} satisfies Record<Status, string>;

export interface StatusDotProps extends ComponentProps<'span'> {
  status: Status;
}

/** The dot alone, for beside a name. Say what it means next to it, or in an `aria-label`. */
export const StatusDot: FC<StatusDotProps> = ({ status, className, ...props }) => {
  return (
    <span
      aria-hidden="true"
      className={cn('inline-block size-1.5 shrink-0 rounded-full', dotColours[status], className)}
      {...props}
    />
  );
};

/** A dot and what it means, written by the caller: `<StatusLabel status="ok">Reporting</StatusLabel>`. */
export const StatusLabel: FC<StatusDotProps> = ({ status, className, children, ...props }) => {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 text-custom-12 whitespace-nowrap',
        status === 'failing' ? 'text-destructive' : 'text-custom-text-secondary',
        className
      )}
      {...props}
    >
      <StatusDot status={status} />
      {children}
    </span>
  );
};
