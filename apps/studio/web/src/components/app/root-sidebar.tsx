import { Suspense, type FC } from 'react';
import {
  BookOpenIcon,
  BuildingsIcon,
  CaretUpDownIcon,
  ChartPieIcon,
  CropIcon,
  GearIcon,
  MapTrifoldIcon,
  RobotIcon,
  TerminalIcon
} from '@phosphor-icons/react';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton
} from '@conservationtv/ui/components/sidebar';

import { NavMain } from '@/components/blocks/sidebar-07/nav-main';
import { NavProjects } from '@/components/blocks/sidebar-07/nav-projects';
import { useOrganisation } from '@/hooks/use-organisation';

// Placeholder navigation, carried over from the sidebar-07 preview until the real sections exist.
const navMain = [
  {
    title: 'Playground',
    url: '#',
    icon: <TerminalIcon />,
    isActive: true,
    items: [
      { title: 'History', url: '#' },
      { title: 'Starred', url: '#' },
      { title: 'Settings', url: '#' }
    ]
  },
  {
    title: 'Models',
    url: '#',
    icon: <RobotIcon />,
    items: [
      { title: 'Genesis', url: '#' },
      { title: 'Explorer', url: '#' },
      { title: 'Quantum', url: '#' }
    ]
  },
  {
    title: 'Documentation',
    url: '#',
    icon: <BookOpenIcon />,
    items: [
      { title: 'Introduction', url: '#' },
      { title: 'Get Started', url: '#' },
      { title: 'Tutorials', url: '#' },
      { title: 'Changelog', url: '#' }
    ]
  },
  {
    title: 'Settings',
    url: '#',
    icon: <GearIcon />,
    items: [
      { title: 'General', url: '#' },
      { title: 'Team', url: '#' },
      { title: 'Billing', url: '#' },
      { title: 'Limits', url: '#' }
    ]
  }
];

const projects = [
  { name: 'Design Engineering', url: '#', icon: <CropIcon /> },
  { name: 'Sales & Marketing', url: '#', icon: <ChartPieIcon /> },
  { name: 'Travel', url: '#', icon: <MapTrifoldIcon /> }
];

/**
 * An organisation's section navigation: a fixed column that doesn't collapse, named for the organisation it's in. Needs
 * a SidebarProvider and the organisation layout above it.
 */
export const RootSidebar: FC = () => {
  return (
    <Sidebar collapsible="none" className="min-h-0 border-r border-border">
      <SidebarContent>
        <NavMain items={navMain} />
        <NavProjects projects={projects} />
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton>
              <GearIcon />
              <span>Organization settings</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            {/* Only this item waits on the organisation; the rest of the sidebar is already there. */}
            <Suspense fallback={<SidebarMenuSkeleton showIcon />}>
              <OrganisationMenuButton />
            </Suspense>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
};

/** The organisation the sidebar is in, by name. Suspends until the organisation has loaded. */
const OrganisationMenuButton: FC = () => {
  const organisation = useOrganisation();
  return (
    <SidebarMenuButton>
      <BuildingsIcon />
      <span className="font-medium">{organisation.name}</span>
      <CaretUpDownIcon className="ml-auto" />
    </SidebarMenuButton>
  );
};
