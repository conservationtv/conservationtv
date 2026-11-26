import { Suspense, type FC } from 'react';
import { useSuspenseQueries } from '@tanstack/react-query';
import { PlusIcon, ScreencastIcon } from '@phosphor-icons/react';
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

import type { Route } from './+types/outputs';
import { Page, PageActions, PageDescription, PageHeader, PageHeading, PageTitle } from '@/components/common/page';
import { StatusLabel } from '@/components/common/status';
import { outputDetailOf, type OutputDetail } from '@/components/outputs/output-detail';
import { useIsAdministrator, useOrganisationId } from '@/hooks/use-organisation';
import { counted } from '@/lib/format';
import { agentListQueryOptions } from '@/queries/agents';
import { channelListQueryOptions } from '@/queries/channels';
import { gatewayListQueryOptions } from '@/queries/gateways';
import { networkListQueryOptions } from '@/queries/networks';
import { outputListQueryOptions } from '@/queries/outputs';
import { showListQueryOptions } from '@/queries/shows';
import { subjectStatusesOf } from '@/components/streams/topology';
import { organisationStatusQueryOptions } from '@/queries/organisations';

export const meta: Route.MetaFunction = () => [{ title: 'Outputs · conservation.tv studio' }];

/**
 * The organisation's outputs: each one OBS on one agent, with what drives its scenes, how its programme is encoded, how
 * many channels and previews it goes to, whether it is recorded, and how it is doing. Administrators make new ones.
 */
const OutputsRoute: FC = () => {
  const administrator = useIsAdministrator();
  return (
    <Page>
      <PageHeader>
        <PageHeading>
          <PageTitle>Outputs</PageTitle>
          <PageDescription>
            Each output is OBS on one of the organisation’s agents, sending its programme to channels and previews. A
            show drives its scenes, or, in the advanced mode, something outside the studio does.
          </PageDescription>
        </PageHeading>
        {administrator && (
          <PageActions>
            <Button nativeButton={false} render={<Link to="new" />}>
              <PlusIcon />
              New output
            </Button>
          </PageActions>
        )}
      </PageHeader>
      <Suspense fallback={<Skeleton className="h-40 w-full" />}>
        <OutputList />
      </Suspense>
      {/* A dialog routed over the page: a new output, at `new`. */}
      <Outlet />
    </Page>
  );
};

export default OutputsRoute;

/** Every output, laid out from the organisation's lists, read once and together. */
const OutputList: FC = () => {
  const organisationId = useOrganisationId();
  const [outputsQuery, showsQuery, agentsQuery, channelsQuery, gatewaysQuery, networksQuery, statusQuery] =
    useSuspenseQueries({
      queries: [
        outputListQueryOptions(organisationId),
        showListQueryOptions(organisationId),
        agentListQueryOptions(organisationId),
        channelListQueryOptions(organisationId),
        gatewayListQueryOptions(organisationId),
        networkListQueryOptions(organisationId),
        { ...organisationStatusQueryOptions(organisationId), select: subjectStatusesOf }
      ]
    });
  if (outputsQuery.data.length === 0) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ScreencastIcon />
          </EmptyMedia>
          <EmptyTitle>No outputs yet</EmptyTitle>
          <EmptyDescription>
            An output sends a show out: an agent runs OBS for it and forwards the programme to your channels.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <ItemGroup className="gap-2">
      {outputsQuery.data.map(output => (
        <OutputRow
          key={output.id}
          detail={outputDetailOf({
            output,
            shows: showsQuery.data,
            agents: agentsQuery.data,
            channels: channelsQuery.data.channels,
            gateways: gatewaysQuery.data,
            networks: networksQuery.data,
            statuses: statusQuery.data
          })}
        />
      ))}
    </ItemGroup>
  );
};

interface OutputRowProps {
  detail: OutputDetail;
}

/** An output, opening its page: its name and status, what drives it, then where it goes out from and to. */
const OutputRow: FC<OutputRowProps> = ({ detail }) => {
  const { output } = detail;
  return (
    <Item variant="outline" render={<Link to={output.id} />}>
      <ItemMedia variant="icon">
        <ScreencastIcon />
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle className="flex-wrap">
          {output.name}
          <StatusLabel status={detail.liveness.status}>{detail.liveness.label}</StatusLabel>
        </ItemTitle>
        <ItemDescription>
          {drivenByOf(detail)} · {detail.agent ? `On ${detail.agent.name}` : 'No agent'} · {detail.encoding}
        </ItemDescription>
        <ItemDescription>
          {channelsOf(detail)} · {previewsOf(detail)} · {detail.recorder ? 'Recorded' : 'Not recorded'}
        </ItemDescription>
      </ItemContent>
    </Item>
  );
};

/** What drives the output's scenes, in a few words. */
function drivenByOf(detail: OutputDetail): string {
  if (detail.output.control === 'external') return 'Driven from outside';
  return detail.show ? `Follows ${detail.show.name}` : 'No show';
}

/** How many channels the output goes to, and how many of those are switched off. */
function channelsOf(detail: OutputDetail): string {
  const total = detail.forwards.length;
  const off = total - detail.liveForwardCount;
  if (total === 0) return 'No channels';
  if (off === 0) return counted(total, 'channel');
  return off === total ? `${counted(total, 'channel')}, off` : `${counted(total, 'channel')}, ${off} off`;
}

/** How many gateways the output is previewed at. */
function previewsOf(detail: OutputDetail): string {
  return detail.previews.length === 0 ? 'No previews' : counted(detail.previews.length, 'preview');
}
