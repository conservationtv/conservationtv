import { Suspense, type FC } from 'react';
import { Outlet } from 'react-router';
import { ScrollArea } from '@conservationtv/ui/components/scroll-area';
import { Spinner } from '@conservationtv/ui/components/spinner';

import { AppBar, AppBarAccount, AppBarHome } from '@/components/app/app-bar';

/**
 * The app's pane as one scrolling page, for the pages that aren't in an organisation (the account, starting an
 * organisation): what the organisation layout gives its pages, without a sidebar. On a phone, the bar over it.
 */
const PageLayout: FC = () => {
  return (
    <>
      <AppBar>
        <AppBarHome />
        <AppBarAccount />
      </AppBar>
      <ScrollArea role="region" aria-label="Page content" className="min-h-0 min-w-0 flex-1 overflow-hidden">
        <Suspense fallback={<Spinner className="m-10 size-5 text-muted-foreground" />}>
          <Outlet />
        </Suspense>
      </ScrollArea>
    </>
  );
};

export default PageLayout;
