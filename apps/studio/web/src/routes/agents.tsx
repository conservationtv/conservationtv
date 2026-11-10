import type { FC } from 'react';
import { useSuspenseQueries } from '@tanstack/react-query';
import { CaretRightIcon, HardDrivesIcon, PlusIcon } from '@phosphor-icons/react';
import { Link, Outlet } from 'react-router';
import type { Agent, Network } from '@conservationtv/studio-sdk';
import { Badge } from '@conservationtv/ui/components/badge';
import { Button } from '@conservationtv/ui/components/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle
} from '@conservationtv/ui/components/empty';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle
} from '@conservationtv/ui/components/item';

import type { Route } from './+types/agents';
import {
  Page,
  PageActions,
  PageDescription,
  PageHeader,
  PageHeading,
  PageTitle,
  Section,
  SectionHeader,
  SectionTitle
} from '@/components/common/page';
import { SubjectHealth } from '@/components/devices/subject-health';
import { deviceSubjectId, statesBySubject, type SubjectState } from '@/components/devices/subjects';
import { useIsAdministrator, useOrganisationId } from '@/hooks/use-organisation';
import { agentListQueryOptions } from '@/queries/agents';
import { networkListQueryOptions } from '@/queries/networks';
import { subjectStateListQueryOptions } from '@/queries/streams';

export const meta: Route.MetaFunction = () => [{ title: 'Agents · conservation.tv studio' }];

/**
 * An organisation's agents, by the network each is on: the programs that pull from the cameras there and deliver
 * their streams. Each opens its own page, which asks the agent itself how it is doing. Administrators add them here.
 */
const AgentsRoute: FC = () => {
  const organisationId = useOrganisationId();
  const administrator = useIsAdministrator();
  const [agentsQuery, networksQuery, statesQuery] = useSuspenseQueries({
    queries: [
      agentListQueryOptions(organisationId),
      networkListQueryOptions(organisationId),
      subjectStateListQueryOptions(organisationId)
    ]
  });
  const networks = networksQuery.data;
  const agents = agentsQuery.data;
  const states = statesBySubject(statesQuery.data);
  return (
    <Page>
      <PageHeader>
        <PageHeading>
          <PageTitle>Agents</PageTitle>
          <PageDescription>
            An agent runs on a machine at one of your sites. The active agent on a network pulls from its cameras and
            delivers their streams; the others stand by.
          </PageDescription>
        </PageHeading>
        {administrator && networks.length > 0 && (
          <PageActions>
            <Button nativeButton={false} render={<Link to="new" />}>
              <PlusIcon />
              Add agent
            </Button>
          </PageActions>
        )}
      </PageHeader>
      {agents.length === 0 && (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <HardDrivesIcon />
            </EmptyMedia>
            <EmptyTitle>No agents yet</EmptyTitle>
            <EmptyDescription>
              {networks.length > 0
                ? 'Add an agent to a network, then start it on a machine there with the key it is given.'
                : 'An agent belongs to a network. Add the network it will run on first.'}
            </EmptyDescription>
          </EmptyHeader>
          {networks.length === 0 && (
            <EmptyContent>
              <Button variant="outline" nativeButton={false} render={<Link to="../networks" relative="path" />}>
                Go to networks
              </Button>
            </EmptyContent>
          )}
        </Empty>
      )}
      {networks.map(network => (
        <NetworkAgents
          key={network.id}
          network={network}
          agents={agents.filter(agent => agent.networkId === network.id)}
          states={states}
        />
      ))}
      {/* A dialog routed over the page, such as adding one: `new`. */}
      <Outlet />
    </Page>
  );
};

export default AgentsRoute;

interface NetworkAgentsProps {
  network: Network;
  /** The agents on this network. */
  agents: Agent[];
  /** What has been reported about each subject, by subject ID. */
  states: Map<string, SubjectState>;
}

/** One network's agents, the active one first; nothing at all for a network without any. */
const NetworkAgents: FC<NetworkAgentsProps> = ({ network, agents, states }) => {
  if (agents.length === 0) return null;
  const ordered = agents.toSorted((a, b) => Number(b.active) - Number(a.active) || b.priority - a.priority);
  return (
    <Section>
      <SectionHeader>
        <SectionTitle>{network.name}</SectionTitle>
      </SectionHeader>
      <ItemGroup className="gap-2">
        {ordered.map(agent => (
          <Item key={agent.id} variant="outline" render={<Link to={agent.id} />}>
            <ItemMedia variant="icon">
              <HardDrivesIcon />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>
                {agent.device?.name ?? 'Unnamed agent'}
                {agent.active ? <Badge variant="secondary">Active</Badge> : <Badge variant="outline">Standby</Badge>}
              </ItemTitle>
              <ItemDescription>Priority {agent.priority}</ItemDescription>
            </ItemContent>
            <ItemActions>
              <SubjectHealth state={states.get(deviceSubjectId(agent.id))} />
              <CaretRightIcon className="size-3.5 text-muted-foreground" aria-hidden="true" />
            </ItemActions>
          </Item>
        ))}
      </ItemGroup>
    </Section>
  );
};
