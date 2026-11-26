import type { ComponentProps, FC } from 'react';
import { cn } from '@conservationtv/ui/lib/utils';

/**
 * A stream's short code (at most four capitals and digits, `stream.code`) as a chip, as chat and a show's controls call
 * it: `<StreamCode>SER1</StreamCode>`.
 */
export const StreamCode: FC<ComponentProps<'span'>> = ({ className, ...props }) => {
  return (
    <span
      className={cn(
        'inline-flex h-5 min-w-9 shrink-0 items-center justify-center rounded-sm bg-muted px-1.5 font-mono text-custom-12 font-semibold text-muted-foreground tabular-nums',
        className
      )}
      {...props}
    />
  );
};
