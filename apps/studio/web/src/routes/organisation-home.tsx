import { Suspense, type ComponentProps, type FC } from 'react';
import { useSuspenseQueries } from '@tanstack/react-query';
import { CheckCircleIcon, CircleIcon, WarningIcon } from '@phosphor-icons/react';
import { Link } from 'react-router';
import { Button } from '@conservationtv/ui/components/button';
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle
} from '@conservationtv/ui/components/item';
import { Skeleton } from '@conservationtv/ui/components/skeleton';
import { cn } from '@conservationtv/ui/lib/utils';

import type { Route } from './+types/organisation-home';
import {
  Page,
  PageDescription,
  PageHeader,
  PageHeading,
  PageTitle,
  Section,
  SectionDescription,
  SectionHeader,
  SectionHeading,
  SectionTitle
} from '@/components/common/page';
import { overviewOf, type Overview, type Problem, type SetupStep } from '@/components/overview/overview';
import { CTVMoQPreview } from '@/components/streams/ctv-moq-preview';
import { useOrganisation, useOrganisationId } from '@/hooks/use-organisation';
import { agentListQueryOptions } from '@/queries/agents';
import { cameraListQueryOptions } from '@/queries/cameras';
import { channelListQueryOptions } from '@/queries/channels';
import { gatewayListQueryOptions } from '@/queries/gateways';
import { networkListQueryOptions } from '@/queries/networks';
import { showListQueryOptions } from '@/queries/shows';
import { streamListQueryOptions, subjectStateListQueryOptions } from '@/queries/streams';

export const meta: Route.MetaFunction = () => [{ title: 'Overview · conservation.tv studio' }];

/** How many fed streams the overview previews: each is a connection of its own, so a handful, not all of them. */
const PREVIEWED_STREAMS = 3;

/**
 * Where an organisation opens: how much of everything it has, what is being fed, and what needs someone to look at it; for
 * an organisation still being set up, the steps to its first stream instead.
 */
const OrganisationHomeRoute: FC = () => {
  return (
    <Page className="max-w-5xl">
      <PageHeader>
        <PageHeading>
          <Suspense fallback={<Skeleton className="h-7 w-48" />}>
            <OrganisationTitle />
          </Suspense>
          <PageDescription>What’s on, what it runs on, and anything that needs looking at.</PageDescription>
        </PageHeading>
      </PageHeader>
      <Suspense fallback={<Skeleton className="h-64 w-full" />}>
        <OverviewSections />
      </Suspense>
    </Page>
  );
};

export default OrganisationHomeRoute;

/** The organisation's name, as the page's title. */
const OrganisationTitle: FC = () => {
  const organisation = useOrganisation();
  return <PageTitle>{organisation.name}</PageTitle>;
};

/** Everything the overview shows, from the organisation's lists, read once and together. */
const OverviewSections: FC = () => {
  const organisationId = useOrganisationId();
  const [
    streamsQuery,
    camerasQuery,
    agentsQuery,
    networksQuery,
    gatewaysQuery,
    showsQuery,
    channelsQuery,
    statesQuery
  ] = useSuspenseQueries({
    queries: [
      streamListQueryOptions(organisationId),
      cameraListQueryOptions(organisationId),
      agentListQueryOptions(organisationId),
      networkListQueryOptions(organisationId),
      gatewayListQueryOptions(organisationId),
      showListQueryOptions(organisationId),
      channelListQueryOptions(organisationId),
      subjectStateListQueryOptions(organisationId)
    ]
  });
  const overview = overviewOf({
    streams: streamsQuery.data,
    cameras: camerasQuery.data,
    agents: agentsQuery.data,
    networks: networksQuery.data,
    gateways: gatewaysQuery.data,
    shows: showsQuery.data,
    channels: channelsQuery.data.channels,
    states: statesQuery.data
  });
  return (
    <>
      <Tiles overview={overview} />
      {overview.setup.some(step => !step.done) && <Setup steps={overview.setup} />}
      <Health problems={overview.problems} reportingCount={overview.reportingCount} />
      {overview.fedStreams.length > 0 && (
        <Section>
          <SectionHeader>
            <SectionHeading>
              <SectionTitle>Being fed</SectionTitle>
              <SectionDescription>
                {overview.fedStreams.length > PREVIEWED_STREAMS
                  ? `${PREVIEWED_STREAMS} of the ${overview.fedStreams.length} streams whose source is on.`
                  : 'The streams whose source is on, as conservation.tv has them.'}
              </SectionDescription>
            </SectionHeading>
            <Button variant="ghost" size="sm" nativeButton={false} render={<Link to="streams" />}>
              All streams
            </Button>
          </SectionHeader>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,16rem),1fr))] gap-6">
            {overview.fedStreams.slice(0, PREVIEWED_STREAMS).map(stream => (
              <Link key={stream.id} to={`streams/${stream.id}`} className="group flex min-w-0 flex-col gap-2">
                <CTVMoQPreview stream={stream.id} />
                <span className="truncate text-custom-13 font-medium text-foreground group-hover:underline">
                  {stream.name}
                </span>
              </Link>
            ))}
          </div>
        </Section>
      )}
    </>
  );
};

interface TilesProps {
  overview: Overview;
}

/** How much of each thing the organisation has, each count opening its page. */
const Tiles: FC<TilesProps> = ({ overview }) => {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,9.5rem),1fr))] gap-3">
      <Tile to="streams">
        <TileValue>{overview.streamCount}</TileValue>
        <TileLabel>Streams</TileLabel>
        <TileNote>{overview.fedStreams.length} being fed</TileNote>
      </Tile>
      <Tile to="cameras">
        <TileValue>{overview.cameraCount}</TileValue>
        <TileLabel>Cameras</TileLabel>
      </Tile>
      <Tile to="agents">
        <TileValue>{overview.agentCount}</TileValue>
        <TileLabel>Agents</TileLabel>
        <TileNote>{overview.activeAgentCount} active</TileNote>
      </Tile>
      <Tile to="networks">
        <TileValue>{overview.networkCount}</TileValue>
        <TileLabel>Networks</TileLabel>
      </Tile>
      <Tile to="shows">
        <TileValue>{overview.showCount}</TileValue>
        <TileLabel>Shows</TileLabel>
        <TileNote>{overview.outputShowCount} with an output agent</TileNote>
      </Tile>
      <Tile to="channels">
        <TileValue>{overview.channelCount}</TileValue>
        <TileLabel>Channels</TileLabel>
      </Tile>
    </div>
  );
};

/** A count that opens the page it counts. Holds a TileValue, a TileLabel and perhaps a TileNote. */
const Tile: FC<ComponentProps<typeof Link>> = ({ className, ...props }) => {
  return (
    <Link
      className={cn(
        'flex min-h-24 flex-col rounded-lg border border-border bg-card px-4 py-3 transition-colors hover:bg-interaction-hover focus-visible:outline-2 focus-visible:outline-ring',
        className
      )}
      {...props}
    />
  );
};

const TileValue: FC<ComponentProps<'span'>> = ({ className, ...props }) => {
  return <span className={cn('text-custom-21 font-semibold text-foreground tabular-nums', className)} {...props} />;
};

const TileLabel: FC<ComponentProps<'span'>> = ({ className, ...props }) => {
  return <span className={cn('text-custom-13 text-foreground', className)} {...props} />;
};

const TileNote: FC<ComponentProps<'span'>> = ({ className, ...props }) => {
  return <span className={cn('mt-auto pt-1 text-custom-12 text-custom-text-secondary', className)} {...props} />;
};

interface SetupProps {
  steps: SetupStep[];
}

/** The way to a first stream, each step ticked once it is done, the rest linking to where they are done. */
const Setup: FC<SetupProps> = ({ steps }) => {
  return (
    <Section>
      <SectionHeader>
        <SectionHeading>
          <SectionTitle>Getting set up</SectionTitle>
          <SectionDescription>From nothing to a camera on air, in order.</SectionDescription>
        </SectionHeading>
      </SectionHeader>
      <ItemGroup className="gap-2">
        {steps.map(step => (
          <Item key={step.to} variant="outline" size="sm" render={<Link to={step.to} />}>
            <ItemMedia variant="icon">
              {step.done ? <CheckCircleIcon weight="fill" className="text-emerald-600" /> : <CircleIcon />}
            </ItemMedia>
            <ItemContent>
              <ItemTitle className={cn(step.done && 'text-custom-text-secondary line-through')}>{step.label}</ItemTitle>
            </ItemContent>
          </Item>
        ))}
      </ItemGroup>
    </Section>
  );
};

interface HealthProps {
  problems: Problem[];
  reportingCount: number;
}

/** What is reporting unhealthy or has gone quiet, each opening its page; or that nothing is, or that nothing reports. */
const Health: FC<HealthProps> = ({ problems, reportingCount }) => {
  return (
    <Section>
      <SectionHeader>
        <SectionTitle>Needs attention</SectionTitle>
      </SectionHeader>
      {problems.length > 0 ? (
        <ItemGroup className="gap-2">
          {problems.map(problem => (
            <Item key={problem.subjectId} variant="outline" size="sm" render={<Link to={problem.to} />}>
              <ItemMedia variant="icon">
                <WarningIcon className="text-destructive" />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{problem.name}</ItemTitle>
                <ItemDescription>{problem.kind} · reporting unhealthy, or gone quiet</ItemDescription>
              </ItemContent>
            </Item>
          ))}
        </ItemGroup>
      ) : (
        <p className="text-custom-13 text-custom-text-secondary">
          {reportingCount > 0
            ? 'Nothing. Everything that reports is healthy.'
            : 'Nothing has reported yet, so there is nothing to say either way.'}
        </p>
      )}
    </Section>
  );
};
