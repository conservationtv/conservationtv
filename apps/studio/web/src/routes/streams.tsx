import { Suspense, type FC } from 'react';
import { useSuspenseQueries } from '@tanstack/react-query';
import { VideoCameraIcon } from '@phosphor-icons/react';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@conservationtv/ui/components/empty';
import { Skeleton } from '@conservationtv/ui/components/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@conservationtv/ui/components/tabs';

import type { Route } from './+types/streams';
import {
  StreamCard,
  StreamCardChart,
  StreamCardNote,
  StreamCardTitle,
  StreamGrid
} from '@/components/streams/stream-card';
import { streamPageOf, type PageStream } from '@/components/streams/stream-page';
import { StreamTopology } from '@/components/streams/stream-topology';
import { CTVMoQPreview } from '@/components/streams/ctv-moq-preview';
import { useOrganisationId } from '@/hooks/use-organisation';
import {
  cameraListQueryOptions,
  deviceListQueryOptions,
  gatewayListQueryOptions,
  networkListQueryOptions,
  streamListQueryOptions,
  subjectStateListQueryOptions
} from '@/queries/streams';

export const meta: Route.MetaFunction = () => [{ title: 'Streams · conservation.tv studio' }];

/** An organisation's streams: those whose source is feeding them, and those that are not. */
const StreamsRoute: FC = () => {
  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-10 py-10">
      <header className="flex flex-col gap-2">
        <h1 className="text-custom-21 font-semibold text-foreground">Streams</h1>
        <p className="max-w-2xl text-custom-13 leading-(--leading-custom-body) text-custom-text-secondary">
          Watch the live stream using the Stream Player or any player that supports HLS/DASH. Instantly replay the
          recording when the live stream ends.
        </p>
      </header>
      <Suspense fallback={<Skeleton className="h-64 w-full" />}>
        <StreamTabs />
      </Suspense>
    </div>
  );
};

export default StreamsRoute;

/** The streams, split by whether their source is feeding them: everything they show, but their charts, read at once. */
const StreamTabs: FC = () => {
  const organisationId = useOrganisationId();
  const [streamsQuery, camerasQuery, devicesQuery, gatewaysQuery, networksQuery, statesQuery] = useSuspenseQueries({
    queries: [
      streamListQueryOptions(organisationId),
      cameraListQueryOptions(organisationId),
      deviceListQueryOptions(organisationId),
      gatewayListQueryOptions(organisationId),
      networkListQueryOptions(organisationId),
      subjectStateListQueryOptions(organisationId)
    ]
  });
  const { active, inactive } = streamPageOf({
    streams: streamsQuery.data,
    cameras: camerasQuery.data,
    devices: devicesQuery.data,
    gateways: gatewaysQuery.data,
    networks: networksQuery.data,
    states: statesQuery.data
  });
  return (
    <Tabs defaultValue="active" className="gap-10">
      <TabsList variant="line" className="w-full justify-start border-b border-border pb-1">
        <TabsTrigger value="active" className="flex-none px-2 text-custom-13">
          Active
          <span className="text-muted-foreground tabular-nums">{active.length}</span>
        </TabsTrigger>
        <TabsTrigger value="inactive" className="flex-none px-2 text-custom-13">
          Inactive
          {inactive.length > 0 && <span className="text-muted-foreground tabular-nums">{inactive.length}</span>}
        </TabsTrigger>
      </TabsList>
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
      <StreamCardTitle>{stream.name}</StreamCardTitle>
      <CTVMoQPreview stream={stream.id} />
      <Suspense fallback={<Skeleton className="h-24 w-full" />}>
        <StreamCardChart stream={stream} />
      </Suspense>
      {stream.topology.nodes.length > 0 ? (
        <StreamTopology topology={stream.topology} statuses={stream.statuses} />
      ) : (
        <StreamCardNote>No source or delivery set up yet.</StreamCardNote>
      )}
    </StreamCard>
  );
};
