import { Suspense, type FC } from 'react';
import { useSuspenseQuery } from '@tanstack/react-query';
import { MonitorPlayIcon, ScreencastIcon } from '@phosphor-icons/react';
import { Link } from 'react-router';
import type { Show } from '@conservationtv/studio-sdk';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@conservationtv/ui/components/empty';
import { Item, ItemContent, ItemGroup, ItemMedia, ItemTitle } from '@conservationtv/ui/components/item';
import { Skeleton } from '@conservationtv/ui/components/skeleton';

import type { Route } from './+types/show';
import { PinButton } from '@/components/app/pins';
import {
  BackLink,
  Fact,
  FactLabel,
  Facts,
  FactValue,
  Page,
  PageActions,
  PageHeader,
  PageHeading,
  PageTitle,
  Section,
  SectionDescription,
  SectionHeader,
  SectionHeading,
  SectionTitle
} from '@/components/common/page';
import { BroadcastStage } from '@/components/shows/broadcast-stage';
import { DeleteShowDialog, RenameShowDialog } from '@/components/shows/show-dialogs';
import { useIsAdministrator, useOrganisationId } from '@/hooks/use-organisation';
import { formatDate } from '@/lib/format';
import { showListQueryOptions } from '@/queries/shows';

export const meta: Route.MetaFunction = () => [{ title: 'Show · conservation.tv studio' }];

/**
 * One show: what is on screen, on its stage, with Compose beside it for now; its name; and the outputs following it,
 * each opening its own page, where how it goes out is. Everyone reads it and may compose it; administrators rename and
 * delete it.
 */
const ShowRoute: FC<Route.ComponentProps> = ({ params }) => {
  return (
    <Page className="max-w-5xl gap-6">
      <BackLink to=".." relative="path">
        Shows
      </BackLink>
      <Suspense fallback={<Skeleton className="h-96 w-full" />}>
        <ShowView key={params.showId} showId={params.showId} />
      </Suspense>
    </Page>
  );
};

export default ShowRoute;

interface ShowViewProps {
  showId: string;
}

/** The show, from the organisation's list, read from the cache that the shows page shares. */
const ShowView: FC<ShowViewProps> = ({ showId }) => {
  const administrator = useIsAdministrator();
  const organisationId = useOrganisationId();
  const { data: show } = useSuspenseQuery({
    ...showListQueryOptions(organisationId),
    select: (shows: Show[]) => shows.find(candidate => candidate.id === showId)
  });
  if (!show) return <ShowNotFound />;
  return (
    <>
      <PageHeader className="items-center">
        <PageHeading>
          <PageTitle className="min-w-0 truncate">{show.name}</PageTitle>
        </PageHeading>
        <PageActions>
          <PinButton label={show.name} kind="show" />
        </PageActions>
      </PageHeader>
      <BroadcastStage key={show.id} showId={show.id} />
      <Section>
        <Facts>
          <Fact>
            <FactLabel>Name</FactLabel>
            <FactValue className="flex items-center gap-1">
              <span className="truncate">{show.name}</span>
              {administrator && <RenameShowDialog show={show} />}
            </FactValue>
          </Fact>
          <Fact>
            <FactLabel>Created</FactLabel>
            <FactValue>{formatDate(show.createdAt)}</FactValue>
          </Fact>
        </Facts>
      </Section>
      <ShowOutputs show={show} />
      {administrator && (
        <Section className="border-t border-border pt-8">
          <SectionHeader>
            <SectionHeading>
              <SectionTitle>Delete this show</SectionTitle>
              <SectionDescription>
                Its composition goes with it. The outputs following it follow nothing until given another show.
              </SectionDescription>
            </SectionHeading>
            <DeleteShowDialog show={show} />
          </SectionHeader>
        </Section>
      )}
    </>
  );
};

interface ShowOutputsProps {
  show: Show;
}

/** The outputs following the show, each opening its page; or, with none, where one is made to follow it. */
const ShowOutputs: FC<ShowOutputsProps> = ({ show }) => {
  return (
    <Section>
      <SectionHeader>
        <SectionHeading>
          <SectionTitle>Going out through</SectionTitle>
          <SectionDescription>
            The outputs following the show: each runs OBS on an agent, which the show’s scenes drive, and sends it to
            its channels and previews.
          </SectionDescription>
        </SectionHeading>
      </SectionHeader>
      {show.outputs.length > 0 ? (
        <ItemGroup className="gap-2">
          {show.outputs.map(output => (
            <Item key={output.id} variant="outline" render={<Link to={`../../outputs/${output.id}`} relative="path" />}>
              <ItemMedia variant="icon">
                <ScreencastIcon />
              </ItemMedia>
              <ItemContent className="min-w-0">
                <ItemTitle>{output.name}</ItemTitle>
              </ItemContent>
            </Item>
          ))}
        </ItemGroup>
      ) : (
        <Empty className="border">
          <EmptyHeader>
            <EmptyTitle>No output follows it</EmptyTitle>
            <EmptyDescription>
              Nothing sends it out yet. Have an output follow it from the output’s page, or make a new one under{' '}
              <Link to="../../outputs" relative="path" className="text-foreground underline underline-offset-2">
                Outputs
              </Link>
              .
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </Section>
  );
};

/** An ID that names no show of this organisation: deleted, or never one. */
const ShowNotFound: FC = () => {
  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <MonitorPlayIcon />
        </EmptyMedia>
        <EmptyTitle>Show not found</EmptyTitle>
        <EmptyDescription>It may have been deleted, or it belongs to another organisation.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
};
