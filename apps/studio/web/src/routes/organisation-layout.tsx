import { Suspense, type FC } from 'react';
import { useSuspenseQuery } from '@tanstack/react-query';
import { Outlet } from 'react-router';
import { ScrollArea } from '@conservationtv/ui/components/scroll-area';
import { SidebarProvider } from '@conservationtv/ui/components/sidebar';
import { Spinner } from '@conservationtv/ui/components/spinner';

import type { Route } from './+types/organisation-layout';
import { RootSidebar } from '@/components/app/root-sidebar';
import { OrganisationContext } from '@/hooks/use-organisation';
import { organisationQueryOptions } from '@/queries/organisations';

/**
 * An organisation's section sidebar beside its pages, and the organisation everything under it is in
 * (`useOrganisationId`, `useOrganisation`). The organisation is read first, so everything under this layout is in one
 * the account can see; one it can't fails here, not in each page.
 */
const OrganisationLayout: FC<Route.ComponentProps> = ({ params }) => {
  useSuspenseQuery(organisationQueryOptions(params.organisationId));
  return (
    <OrganisationContext value={params.organisationId}>
      {/* The provider's wrapper is the row itself: sized to the pane rather than the viewport. */}
      <SidebarProvider className="min-h-0 min-w-0 flex-1 overflow-hidden" style={{ '--sidebar-width': '13rem' }}>
        <RootSidebar />
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
