import type { FC, ReactNode } from 'react';
import { NavLink, useLocation, useMatches, useResolvedPath } from 'react-router';
import { Tabs, TabsList, TabsTrigger } from '@conservationtv/ui/components/tabs';

// Line tabs whose tabs are links: the route decides which one is current, and choosing one navigates. Each tab's
// value is the path it links to, so the current tab is the one whose path is the settings page that's open: the route
// matched just beneath the settings layout, which a dialog routed over that page (members' `invite`) doesn't change.

export interface SettingsTabsProps {
  /** SettingsTab elements. */
  children: ReactNode;
}

/** The settings pages' tabs, as a line under the page's title, with the tab for the current page underlined. */
export const SettingsTabs: FC<SettingsTabsProps> = ({ children }) => {
  const location = useLocation();
  const matches = useMatches();
  const layout = matches.findIndex(match => match.id === 'routes/settings-layout');
  const page = matches[layout + 1]?.pathname ?? location.pathname;
  return (
    <Tabs value={withoutTrailingSlash(page)}>
      <TabsList variant="line" className="w-full justify-start border-b border-border pb-1">
        {children}
      </TabsList>
    </Tabs>
  );
};

export interface SettingsTabProps {
  /** Where the tab goes, relative to the route that renders it. */
  to: string;
  children: ReactNode;
}

/** One tab: a link to a settings page, current while that page is open. */
export const SettingsTab: FC<SettingsTabProps> = ({ to, children }) => {
  const path = useResolvedPath(to);
  return (
    <TabsTrigger
      value={withoutTrailingSlash(path.pathname)}
      nativeButton={false}
      render={<NavLink to={to} end />}
      className="flex-none px-2 text-custom-13"
    >
      {children}
    </TabsTrigger>
  );
};

/** `/a/b/` and `/a/b` are the same page. */
function withoutTrailingSlash(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/$/, '') : pathname;
}
