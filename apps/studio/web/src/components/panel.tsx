import type { ReactNode, FC } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@conservationtv/ui/components/card';
import { cn } from '@conservationtv/ui/lib/utils';

import { AnimateHeight } from '@/components/animate-height';

/** A centred card for the account page and the error screen. The sign-in screens use SignInFrame instead. */
export const Panel: FC<PanelBodyProps> = body => {
  return (
    <PanelColumn>
      <PanelCard>
        <PanelBody {...body} />
      </PanelCard>
    </PanelColumn>
  );
};

export interface PanelColumnProps {
  children: ReactNode;
}

/**
 * The narrow column a panel's card sits in. Anchored from the top rather than centred, so the card's top edge (and
 * anything above it) stays put while its height changes, and it grows and shrinks downward. The offset puts a typical
 * card a little above the middle on a tall window, and falls back to the usual padding on a short one.
 */
export const PanelColumn: FC<PanelColumnProps> = ({ children }) => {
  return (
    <main className="mx-auto min-h-svh w-full max-w-sm px-6 pt-[max(1.5rem,calc(40svh-12.5rem))] pb-6">{children}</main>
  );
};

export interface PanelCardProps {
  /** The card's contents: usually a PanelBody. */
  children: ReactNode;
  className?: string;
}

/**
 * The card itself. Clipped rather than hidden, so focusing a field that's still sliding in can't scroll the card's
 * contents sideways inside it. The card eases to its contents' height as they change, rather than jumping; inside,
 * they're laid out as the card itself would.
 */
export const PanelCard: FC<PanelCardProps> = ({ children, className }) => {
  return (
    <Card className={cn('overflow-clip', className)}>
      <AnimateHeight>
        <div className="flex flex-col gap-(--card-spacing)">{children}</div>
      </AnimateHeight>
    </Card>
  );
};

export interface PanelBodyProps extends PanelHeaderProps {
  children?: ReactNode;
}

/** What's in a panel's card: its title, an optional description, and its contents. */
export const PanelBody: FC<PanelBodyProps> = ({ title, description, children }) => {
  return (
    <>
      <PanelHeader title={title} description={description} />
      {children && <PanelContent>{children}</PanelContent>}
    </>
  );
};

export interface PanelHeaderProps {
  title: string;
  description?: ReactNode;
}

/** A panel card's title and optional description. */
export const PanelHeader: FC<PanelHeaderProps> = ({ title, description }) => {
  return (
    <CardHeader>
      <CardTitle className="text-base">{title}</CardTitle>
      {description && <CardDescription>{description}</CardDescription>}
    </CardHeader>
  );
};

export interface PanelContentProps {
  children: ReactNode;
}

/** A panel card's contents, under its header. */
export const PanelContent: FC<PanelContentProps> = ({ children }) => {
  return <CardContent className="flex flex-col gap-6">{children}</CardContent>;
};
