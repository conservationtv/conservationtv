import { Suspense, type FC } from 'react';
import { useSuspenseQueries } from '@tanstack/react-query';
import { MonitorPlayIcon } from '@phosphor-icons/react';
import { Link } from 'react-router';
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
import { StatusLabel } from '@/components/common/status';
import { NewShowDialog } from '@/components/shows/show-dialogs';
import { showDetailOf, type ShowDetail } from '@/components/shows/show-detail';
import { useIsAdministrator, useOrganisationId } from '@/hooks/use-organisation';
import { counted } from '@/lib/format';
import { agentListQueryOptions } from '@/queries/agents';
import { channelListQueryOptions } from '@/queries/channels';
import { gatewayListQueryOptions } from '@/queries/gateways';
import { networkListQueryOptions } from '@/queries/networks';
import { showListQueryOptions } from '@/queries/shows';
import { subjectStateListQueryOptions } from '@/queries/streams';

export const meta: Route.MetaFunction = () => [{ title: 'Shows · conservation.tv studio' }];

/**
 * The organisation's shows going out: each with the agent that sends it out, how its programme is encoded, how many
 * channels and previews it goes to, whether it is recorded, and how it is doing. Administrators make new ones.
 */
const ShowsRoute: FC = () => {
  const administrator = useIsAdministrator();
  return (
    <Page>
      <PageHeader>
        <PageHeading>
          <PageTitle>Shows</PageTitle>
          <PageDescription>
            Every show follows the organisation’s one broadcast for now, so each has the same picture. What differs is
            how it goes out: the agent that runs OBS for it, its encoding, its channels, previews and recording.
          </PageDescription>
        </PageHeading>
        {administrator && (
          <PageActions>
            <NewShowDialog />
          </PageActions>
        )}
      </PageHeader>
      <Suspense fallback={<Skeleton className="h-40 w-full" />}>
        <ShowList />
      </Suspense>
    </Page>
  );
};

export default ShowsRoute;

/** Every show, laid out from the organisation's lists, read once and together. */
const ShowList: FC = () => {
  const organisationId = useOrganisationId();
  const [showsQuery, agentsQuery, channelsQuery, gatewaysQuery, networksQuery, statesQuery] = useSuspenseQueries({
    queries: [
      showListQueryOptions(organisationId),
      agentListQueryOptions(organisationId),
      channelListQueryOptions(organisationId),
      gatewayListQueryOptions(organisationId),
      networkListQueryOptions(organisationId),
      subjectStateListQueryOptions(organisationId)
    ]
  });
  if (showsQuery.data.length === 0) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <MonitorPlayIcon />
          </EmptyMedia>
          <EmptyTitle>No shows yet</EmptyTitle>
          <EmptyDescription>
            A show sends the broadcast out: an agent runs OBS for it and forwards the programme to your channels.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <ItemGroup className="gap-2">
      {showsQuery.data.map(show => (
        <ShowRow
          key={show.id}
          detail={showDetailOf({
            show,
            agents: agentsQuery.data,
            channels: channelsQuery.data.channels,
            gateways: gatewaysQuery.data,
            networks: networksQuery.data,
            states: statesQuery.data
          })}
        />
      ))}
    </ItemGroup>
  );
};

interface ShowRowProps {
  detail: ShowDetail;
}

/** A show, opening its page: its name and status, then where it goes out from and to. */
const ShowRow: FC<ShowRowProps> = ({ detail }) => {
  const { show } = detail;
  return (
    <Item variant="outline" render={<Link to={show.id} />}>
      <ItemMedia variant="icon">
        <MonitorPlayIcon />
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle className="flex-wrap">
          {show.name}
          <StatusLabel status={detail.liveness.status}>{detail.liveness.label}</StatusLabel>
        </ItemTitle>
        <ItemDescription>
          {detail.output ? `Sent out by ${detail.output.name}` : 'No output agent'} · {detail.encoding}
        </ItemDescription>
        <ItemDescription>
          {channelsOf(detail)} · {previewsOf(detail)} · {detail.recorder ? 'Recorded' : 'Not recorded'}
        </ItemDescription>
      </ItemContent>
    </Item>
  );
};

/** How many channels the show goes to, and how many of those are switched off. */
function channelsOf(detail: ShowDetail): string {
  const total = detail.forwards.length;
  const off = total - detail.liveForwardCount;
  if (total === 0) return 'No channels';
  if (off === 0) return counted(total, 'channel');
  return off === total ? `${counted(total, 'channel')}, off` : `${counted(total, 'channel')}, ${off} off`;
}

/** How many gateways the show is previewed at. */
function previewsOf(detail: ShowDetail): string {
  return detail.previews.length === 0 ? 'No previews' : counted(detail.previews.length, 'preview');
}
