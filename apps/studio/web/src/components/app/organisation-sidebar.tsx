import { Suspense, type FC, type ReactNode } from 'react';
import { useSuspenseQuery } from '@tanstack/react-query';
import {
  BroadcastIcon,
  BuildingsIcon,
  CaretUpDownIcon,
  CheckIcon,
  CloudIcon,
  DevicesIcon,
  GearIcon,
  HardDrivesIcon,
  HouseIcon,
  MonitorPlayIcon,
  NetworkIcon,
  PlusIcon,
  UploadSimpleIcon,
  VideoCameraIcon,
  VideoIcon
} from '@phosphor-icons/react';
import { Link, NavLink, useMatch, useResolvedPath } from 'react-router';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@conservationtv/ui/components/dropdown-menu';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton
} from '@conservationtv/ui/components/sidebar';
import { useSidebar } from '@conservationtv/ui/hooks/use-sidebar';

import { useOrganisation, useOrganisationId } from '@/hooks/use-organisation';
import { organisationListQueryOptions } from '@/queries/organisations';

/**
 * An organisation's section navigation: what is on air first, then what that runs on, and the organisation itself at
 * the foot. Beside the pages, a fixed column that doesn't collapse; on a phone, where there's no room for it, a sheet
 * the app bar's button slides out, put away again as one of its pages is opened. Needs a SidebarProvider and the
 * organisation layout above it.
 */
export const OrganisationSidebar: FC = () => {
  const sidebar = useSidebar();
  const collapsible = sidebar.isMobile ? 'offcanvas' : 'none';
  return (
    <Sidebar collapsible={collapsible} className="min-h-0 border-r border-border">
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarNavItem to="." end>
                <HouseIcon />
                <span>Overview</span>
              </SidebarNavItem>
              <SidebarNavItem to="streams">
                <VideoIcon />
                <span>Streams</span>
              </SidebarNavItem>
              <SidebarNavItem to="shows">
                <MonitorPlayIcon />
                <span>Shows</span>
              </SidebarNavItem>
              <SidebarNavItem to="channels">
                <BroadcastIcon />
                <span>Channels</span>
              </SidebarNavItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>Infrastructure</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarNavItem to="networks">
                <NetworkIcon />
                <span>Networks</span>
              </SidebarNavItem>
              <SidebarNavItem to="agents">
                <HardDrivesIcon />
                <span>Agents</span>
              </SidebarNavItem>
              <SidebarNavItem to="cameras">
                <VideoCameraIcon />
                <span>Cameras</span>
              </SidebarNavItem>
              <SidebarNavItem to="gateways">
                <CloudIcon />
                <span>Gateways</span>
              </SidebarNavItem>
              <SidebarNavItem to="publishers">
                <UploadSimpleIcon />
                <span>Publishers</span>
              </SidebarNavItem>
              <SidebarNavItem to="devices">
                <DevicesIcon />
                <span>Devices</span>
              </SidebarNavItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarNavItem to="settings">
            <GearIcon />
            <span>Organisation settings</span>
          </SidebarNavItem>
          <SidebarMenuItem>
            {/* Only this item waits on the organisation; the rest of the sidebar is already there. */}
            <Suspense fallback={<SidebarMenuSkeleton showIcon />}>
              <OrganisationSwitcher />
            </Suspense>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
};

interface SidebarNavItemProps {
  /** Relative to the organisation: `streams`, or `.` for its overview. */
  to: string;
  /** Current only on exactly this path, not on the pages beneath it. */
  end?: boolean;
  /** An icon, then the label in a span. */
  children: ReactNode;
}

/**
 * A sidebar entry for one of the organisation's pages, current while that page or one beneath it is open. Following
 * it puts the phone's sheet away, for the page to have the screen.
 */
const SidebarNavItem: FC<SidebarNavItemProps> = ({ to, end = false, children }) => {
  const sidebar = useSidebar();
  const path = useResolvedPath(to);
  const match = useMatch({ path: path.pathname, end });
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={match !== null}
        render={<NavLink to={to} end={end} onClick={() => sidebar.setOpenMobile(false)} />}
      >
        {children}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
};

/**
 * The organisation the sidebar is in, by name, opening the account's other organisations and a way to start one.
 * Suspends until the organisation and the list have loaded.
 */
const OrganisationSwitcher: FC = () => {
  const sidebar = useSidebar();
  const organisationId = useOrganisationId();
  const organisation = useOrganisation();
  const organisationsQuery = useSuspenseQuery(organisationListQueryOptions());
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<SidebarMenuButton />}>
        <BuildingsIcon />
        <span className="truncate font-medium">{organisation.name}</span>
        <CaretUpDownIcon className="ml-auto" />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="min-w-52">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Organisations</DropdownMenuLabel>
          {organisationsQuery.data.map(listed => (
            <DropdownMenuItem
              key={listed.id}
              render={<Link to={`/organisations/${listed.id}`} />}
              onClick={() => sidebar.setOpenMobile(false)}
            >
              <BuildingsIcon />
              <span className="truncate">{listed.name}</span>
              {listed.id === organisationId && <CheckIcon className="ml-auto" />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem render={<Link to="/organisations/new" />} onClick={() => sidebar.setOpenMobile(false)}>
            <PlusIcon />
            New organisation
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

/** The organisation's name, for the app bar over its pages on a phone. Suspends until the organisation has loaded. */
export const OrganisationName: FC = () => {
  const organisation = useOrganisation();
  return organisation.name;
};
