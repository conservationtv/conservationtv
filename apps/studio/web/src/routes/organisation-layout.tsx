import { Suspense, type FC } from 'react';
import { usePrefetchQuery } from '@tanstack/react-query';
import { Outlet } from 'react-router';
import { ScrollArea } from '@conservationtv/ui/components/scroll-area';
import { SidebarProvider } from '@conservationtv/ui/components/sidebar';
import { Spinner } from '@conservationtv/ui/components/spinner';

import type { Route } from './+types/organisation-layout';
import { AppBar, AppBarAccount, AppBarHome, AppBarSidebarTrigger, AppBarTitle } from '@/components/app/app-bar';
import { OrganisationName, OrganisationSidebar } from '@/components/app/organisation-sidebar';
import { OrganisationContext } from '@/hooks/use-organisation';
import { organisationQueryOptions } from '@/queries/organisations';

/**
 * An organisation's section sidebar beside its pages, and the organisation everything under it is in
 * (`useOrganisationId`, `useOrganisation`). The organisation starts loading here but isn't waited on: the sidebar and
 * pages render straight away, and only what reads the organisation suspends, under its own boundary. On a phone the
 * sidebar is a sheet instead, slid out from the bar above the page, which names the organisation.
 */
const OrganisationLayout: FC<Route.ComponentProps> = ({ params }) => {
  usePrefetchQuery(organisationQueryOptions(params.organisationId));
  return (
    <OrganisationContext value={params.organisationId}>
      {/* The provider's wrapper is the row itself, sized to the pane rather than the viewport: on a phone, a column of
          the bar over the page, the sidebar being a sheet. */}
      <SidebarProvider
        className="min-h-0 min-w-0 flex-1 flex-col overflow-hidden md:flex-row"
        style={{ '--sidebar-width': '13rem' }}
      >
        <AppBar>
          <AppBarSidebarTrigger />
          <AppBarHome />
          <AppBarTitle>
            <Suspense fallback={null}>
              <OrganisationName />
            </Suspense>
          </AppBarTitle>
          <AppBarAccount />
        </AppBar>
        <OrganisationSidebar />
        <ScrollArea role="region" aria-label="Page content" className="min-h-0 min-w-0 flex-1 overflow-hidden">
          {/* The sidebar stays while a page's queries load. */}
          <Suspense fallback={<Spinner className="m-10 size-5 text-muted-foreground" />}>
            <Outlet />
          </Suspense>
        </ScrollArea>
      </SidebarProvider>
    </OrganisationContext>
  );
};

export default OrganisationLayout;
