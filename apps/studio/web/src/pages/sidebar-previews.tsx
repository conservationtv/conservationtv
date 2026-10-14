import type { FC } from 'react';
import { AppSidebar as IconSidebar } from '@/components/blocks/sidebar-07/app-sidebar';
import { AppSidebar as InboxSidebar } from '@/components/blocks/sidebar-09/app-sidebar';
import { AppSidebar as HeaderSidebar } from '@/components/blocks/sidebar-16/app-sidebar';
import { SiteHeader } from '@/components/blocks/sidebar-16/site-header';
import { PreviewControls } from '@/components/previews/preview-controls';
import { ThemeSample } from '@/components/previews/theme-sample';
import { Separator } from '@conservationtv/ui/components/separator';
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@conservationtv/ui/components/sidebar';

export const Sidebar07Page: FC = () => {
  return (
    <SidebarProvider>
      <IconSidebar />
      <SidebarInset>
        <header className="flex min-h-14 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-2 data-vertical:h-4 data-vertical:self-auto" />
          <span className="hidden text-custom-13 font-medium lg:block">Sidebar 07 · Icons</span>
          <PreviewControls />
        </header>
        <ThemeSample />
      </SidebarInset>
    </SidebarProvider>
  );
};

export const Sidebar09Page: FC = () => {
  return (
    <SidebarProvider style={{ '--sidebar-width': '350px' }}>
      <InboxSidebar />
      <SidebarInset>
        <header className="sticky top-0 z-10 flex min-h-14 shrink-0 items-center gap-2 border-b bg-background px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-2 data-vertical:h-4 data-vertical:self-auto" />
          <span className="hidden text-custom-13 font-medium lg:block">Sidebar 09 · Inbox</span>
          <PreviewControls />
        </header>
        <ThemeSample />
      </SidebarInset>
    </SidebarProvider>
  );
};

export const Sidebar16Page: FC = () => {
  return (
    <div className="[--header-height:calc(--spacing(14))]">
      <SidebarProvider className="flex flex-col">
        <SiteHeader />
        <div className="flex flex-1">
          <HeaderSidebar />
          <SidebarInset>
            <ThemeSample />
          </SidebarInset>
        </div>
      </SidebarProvider>
    </div>
  );
};
