import type { FC } from 'react';
import { ScrollArea, ScrollBar } from '@conservationtv/ui/components/scroll-area';
import { SidebarProvider } from '@conservationtv/ui/components/sidebar';

import { RootSidebar } from '@/components/root-sidebar';

const HomeRoute: FC = () => {
  return (
    // The provider's wrapper is the row itself: sized to the pane rather than the viewport, at the sidebar's old width.
    <SidebarProvider className="min-h-0 min-w-0 flex-1 overflow-hidden" style={{ '--sidebar-width': '13rem' }}>
      <RootSidebar />
      <ScrollArea role="region" aria-label="Page content" className="min-h-0 min-w-0 flex-1 overflow-hidden">
        <ScrollBar orientation="horizontal" />

        <div className="h-[400vh] w-10 bg-linear-to-b from-red-400 to-yellow-400 m-8 rotate-1" />
      </ScrollArea>
    </SidebarProvider>
  );
};

export default HomeRoute;
