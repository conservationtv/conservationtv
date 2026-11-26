import { Suspense, type FC } from 'react';
import { useSuspenseQueries } from '@tanstack/react-query';
import { PlusIcon, VideoCameraIcon } from '@phosphor-icons/react';
import { Link } from 'react-router';
import { Button } from '@conservationtv/ui/components/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@conservationtv/ui/components/empty';
import { Skeleton } from '@conservationtv/ui/components/skeleton';
import { Tabs, TabsContent } from '@conservationtv/ui/components/tabs';

import type { Route } from './+types/streams';
import { Page, PageDescription, PageHeader, PageHeading, PageTitle } from '@/components/common/page';
import { PageTabsBar, PageTabsList, PageTabsTrigger } from '@/components/common/page-tabs';
import {
  StreamCard,
  StreamCardChart,
  StreamCardNote,
  StreamCardTitle,
  StreamGrid
} from '@/components/streams/stream-card';
import { StreamCode } from '@/components/streams/stream-code';
import { streamPageOf, type PageStream } from '@/components/streams/stream-page';
import { TopologyDiagram } from '@/components/streams/stream-topology';
import { CTVMoQPreview } from '@/components/streams/ctv-moq-preview';
import { useTabsQuery } from '@/hooks/use-tabs-query';
import { useIsAdministrator, useOrganisationId } from '@/hooks/use-organisation';
import { cameraListQueryOptions } from '@/queries/cameras';
import { deviceListQueryOptions } from '@/queries/devices';
import { gatewayListQueryOptions } from '@/queries/gateways';
import { networkListQueryOptions } from '@/queries/networks';
import { subjectStatusesOf } from '@/components/streams/topology';
import { organisationStatusQueryOptions } from '@/queries/organisations';
import { streamListQueryOptions } from '@/queries/streams';

export const meta: Route.MetaFunction = () => [{ title: 'Streams · conservation.tv studio' }];

/** An organisation's streams: those whose source is feeding them, and those that are not. */
const StreamsRoute: FC = () => {
  return (
    <Page className="max-w-7xl">
      <PageHeader>
        <PageHeading>
          <PageTitle>Streams</PageTitle>
          <PageDescription>
            Every live picture the organisation has, and how each is delivered: from its source, across its network, out
            to conservation.tv.
          </PageDescription>
        </PageHeading>
        <Suspense fallback={null}>
          <NewStreamAction />
        </Suspense>
      </PageHeader>
      <Suspense fallback={<Skeleton className="h-64 w-full" />}>
        <StreamTabs />
      </Suspense>
    </Page>
  );
};

export default StreamsRoute;

/** For administrators: a way to the new-stream page. */
const NewStreamAction: FC = () => {
  const administrator = useIsAdministrator();
  if (!administrator) return null;
  return (
    <Button nativeButton={false} render={<Link to="new" />}>
      <PlusIcon />
      New stream
    </Button>
  );
};

/** The streams, split by whether their source is feeding them: everything they show, but their charts, read at once. */
const StreamTabs: FC = () => {
  const organisationId = useOrganisationId();
  const [streamsQuery, camerasQuery, devicesQuery, gatewaysQuery, networksQuery, statusQuery] = useSuspenseQueries({
    queries: [
      streamListQueryOptions(organisationId),
      cameraListQueryOptions(organisationId),
      deviceListQueryOptions(organisationId),
      gatewayListQueryOptions(organisationId),
      networkListQueryOptions(organisationId),
      { ...organisationStatusQueryOptions(organisationId), select: subjectStatusesOf }
    ]
  });
  const { active, inactive } = streamPageOf({
    streams: streamsQuery.data,
    cameras: camerasQuery.data,
    devices: devicesQuery.data,
    gateways: gatewaysQuery.data,
    networks: networksQuery.data,
    statuses: statusQuery.data
  });
  // Which of them the list shows, as `?status=`: those being fed, or the rest.
  const tabs = useTabsQuery('status', ['active', 'inactive']);
  return (
    <Tabs {...tabs} className="gap-10">
      <PageTabsBar>
        <PageTabsList>
          <PageTabsTrigger value="active">
            Active
            <span className="text-muted-foreground tabular-nums">{active.length}</span>
          </PageTabsTrigger>
          <PageTabsTrigger value="inactive">
            Inactive
            {inactive.length > 0 && <span className="text-muted-foreground tabular-nums">{inactive.length}</span>}
          </PageTabsTrigger>
        </PageTabsList>
      </PageTabsBar>
      <TabsContent value="active">
        {active.length > 0 ? (
          <StreamGrid>
            {active.map(stream => (
              <StreamItem key={stream.id} stream={stream} />
            ))}
          </StreamGrid>
        ) : (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <VideoCameraIcon />
              </EmptyMedia>
              <EmptyTitle>No streams</EmptyTitle>
              <EmptyDescription>No streams are being fed right now.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </TabsContent>
      <TabsContent value="inactive">
        {inactive.length > 0 ? (
          <StreamGrid>
            {inactive.map(stream => (
              <StreamItem key={stream.id} stream={stream} />
            ))}
          </StreamGrid>
        ) : (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <VideoCameraIcon />
              </EmptyMedia>
              <EmptyTitle>No streams</EmptyTitle>
              <EmptyDescription>Every stream has an enabled source.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </TabsContent>
    </Tabs>
  );
};

interface StreamItemProps {
  stream: PageStream;
}

/** A stream's card: its topology is already loaded with the page; its chart loads in on its own. */
const StreamItem: FC<StreamItemProps> = ({ stream }) => {
  return (
    <StreamCard>
      <StreamCardTitle className="flex min-w-0 items-center gap-2">
        {stream.code && <StreamCode>{stream.code}</StreamCode>}
        <Link to={stream.id} className="truncate hover:underline hover:underline-offset-4">
          {stream.name}
        </Link>
      </StreamCardTitle>
      <CTVMoQPreview stream={stream.id} />
      <Suspense fallback={<Skeleton className="h-24 w-full" />}>
        <StreamCardChart stream={stream} />
      </Suspense>
      {stream.topology.nodes.length > 0 ? (
        <TopologyDiagram topology={stream.topology} statuses={stream.statuses} />
      ) : (
        <StreamCardNote>No source or delivery set up yet.</StreamCardNote>
      )}
    </StreamCard>
  );
};
