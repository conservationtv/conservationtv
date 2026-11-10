import { Suspense, type FC } from 'react';
import { Outlet } from 'react-router';
import { Spinner } from '@conservationtv/ui/components/spinner';

import type { Route } from './+types/settings-layout';
import { Page, PageDescription, PageHeader, PageHeading, PageTitle } from '@/components/common/page';
import { SettingsTab, SettingsTabs } from '@/components/settings/settings-tabs';

export const meta: Route.MetaFunction = () => [{ title: 'Organisation settings · conservation.tv studio' }];

/**
 * The organisation's own settings, under one title and a line of tabs: General, Members and Roles. Each tab is a page
 * of its own, rendered below the tabs; the title and tabs stay while a tab's data loads.
 */
const SettingsLayoutRoute: FC = () => {
  return (
    <Page>
      <PageHeader>
        <PageHeading>
          <PageTitle>Organisation settings</PageTitle>
          <PageDescription>The organisation itself, the people in it, and what each of them may do.</PageDescription>
        </PageHeading>
      </PageHeader>
      <SettingsTabs>
        <SettingsTab to="">General</SettingsTab>
        <SettingsTab to="members">Members</SettingsTab>
        <SettingsTab to="roles">Roles</SettingsTab>
      </SettingsTabs>
      <Suspense fallback={<Spinner className="size-5 text-muted-foreground" />}>
        <Outlet />
      </Suspense>
    </Page>
  );
};

export default SettingsLayoutRoute;
