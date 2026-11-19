import { Suspense, type FC } from 'react';
import { useSuspenseQuery } from '@tanstack/react-query';
import { MonitorPlayIcon, PlusIcon } from '@phosphor-icons/react';
import { Link, Outlet } from 'react-router';
import { Button } from '@conservationtv/ui/components/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@conservationtv/ui/components/empty';
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle
} from '@conservationtv/ui/components/item';
import { Skeleton } from '@conservationtv/ui/components/skeleton';

import type { Route } from './+types/shows';
import { Page, PageActions, PageDescription, PageHeader, PageHeading, PageTitle } from '@/components/common/page';
import { useIsAdministrator, useOrganisationId } from '@/hooks/use-organisation';
import { showListQueryOptions } from '@/queries/shows';

export const meta: Route.MetaFunction = () => [{ title: 'Shows · conservation.tv studio' }];

/**
 * The organisation's shows: what is on screen, each composed from its streams, with the outputs following it, which
 * send it out. Administrators make new ones.
 */
const ShowsRoute: FC = () => {
  const administrator = useIsAdministrator();
  return (
    <Page>
      <PageHeader>
        <PageHeading>
          <PageTitle>Shows</PageTitle>
          <PageDescription>
            A show is what is on screen: the streams it places, composed into scenes. It goes out through each output
            that follows it.
          </PageDescription>
        </PageHeading>
        {administrator && (
          <PageActions>
            <Button nativeButton={false} render={<Link to="new" />}>
              <PlusIcon />
              New show
            </Button>
          </PageActions>
        )}
      </PageHeader>
      <Suspense fallback={<Skeleton className="h-40 w-full" />}>
        <ShowList />
      </Suspense>
      {/* A dialog routed over the page: a new show, at `new`. */}
      <Outlet />
    </Page>
  );
};

export default ShowsRoute;

/** Every show, each opening its page: its name, and the outputs following it. */
const ShowList: FC = () => {
  const organisationId = useOrganisationId();
  const { data: shows } = useSuspenseQuery(showListQueryOptions(organisationId));
  if (shows.length === 0) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <MonitorPlayIcon />
          </EmptyMedia>
          <EmptyTitle>No shows yet</EmptyTitle>
          <EmptyDescription>
            A show composes the organisation’s streams into what is on screen. Outputs follow it to send it out.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <ItemGroup className="gap-2">
      {shows.map(show => (
        <Item key={show.id} variant="outline" render={<Link to={show.id} />}>
          <ItemMedia variant="icon">
            <MonitorPlayIcon />
          </ItemMedia>
          <ItemContent className="min-w-0">
            <ItemTitle>{show.name}</ItemTitle>
            <ItemDescription>
              {show.outputs.length === 0
                ? 'No output follows it'
                : `Sent out by ${show.outputs.map(output => output.name).join(', ')}`}
            </ItemDescription>
          </ItemContent>
        </Item>
      ))}
    </ItemGroup>
  );
};
