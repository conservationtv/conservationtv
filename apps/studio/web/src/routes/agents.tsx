import { useState, type FC } from 'react';
import { useForm } from '@tanstack/react-form';
import { useSuspenseQueries } from '@tanstack/react-query';
import { CaretRightIcon, HardDrivesIcon, PlusIcon } from '@phosphor-icons/react';
import { Link, useNavigate } from 'react-router';
import type { Agent, Network } from '@conservationtv/studio-sdk';
import { Badge } from '@conservationtv/ui/components/badge';
import { Button } from '@conservationtv/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from '@conservationtv/ui/components/dialog';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle
} from '@conservationtv/ui/components/empty';
import { FieldGroup } from '@conservationtv/ui/components/field';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle
} from '@conservationtv/ui/components/item';
import { NativeSelectOption } from '@conservationtv/ui/components/native-select';

import type { Route } from './+types/agents';
import { FormError } from '@/components/common/form-error';
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
import { NewAgentSchema, type NewAgentInput } from '@/forms/schemas';
import { SelectField } from '@/forms/select-field';
import { TextField } from '@/forms/text-field';
import { useIsAdministrator, useOrganisationId } from '@/hooks/use-organisation';
import { agentListQueryOptions, useCreateAgent } from '@/queries/agents';
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
            <AddAgentDialog networks={networks} />
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

interface AddAgentDialogProps {
  networks: Network[];
}

/**
 * Adds an agent to a network, then opens its page, where its key is: the agent is only a record until a machine is
 * started with it.
 */
const AddAgentDialog: FC<AddAgentDialogProps> = ({ networks }) => {
  const organisationId = useOrganisationId();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const create = useCreateAgent(organisationId);
  const defaultValues: NewAgentInput = { name: '', networkId: networks[0]?.id ?? '', priority: '0' };
  const form = useForm({
    defaultValues,
    validators: { onSubmit: NewAgentSchema },
    onSubmit: ({ value }) => create.mutate(NewAgentSchema.parse(value), { onSuccess: agent => navigate(agent.id) })
  });
  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        setOpen(next);
        if (!next) create.reset();
      }}
    >
      <DialogTrigger render={<Button />}>
        <PlusIcon />
        Add agent
      </DialogTrigger>
      <DialogContent>
        <form
          onSubmit={event => {
            event.preventDefault();
            form.handleSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Add an agent</DialogTitle>
            <DialogDescription>
              It gets an identity of its own. Its page then shows the key to start it with on a machine at the site.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-4">
            <form.Field name="name">
              {field => <TextField field={field} label="Name" placeholder="Hide agent" autoComplete="off" />}
            </form.Field>
            <form.Field name="networkId">
              {field => (
                <SelectField field={field} label="Network">
                  {networks.map(network => (
                    <NativeSelectOption key={network.id} value={network.id}>
                      {network.name}
                    </NativeSelectOption>
                  ))}
                </SelectField>
              )}
            </form.Field>
            <form.Field name="priority">
              {field => (
                <TextField
                  field={field}
                  label="Priority"
                  description="Among a network’s agents, the highest is preferred as the active one."
                  inputMode="numeric"
                  autoComplete="off"
                />
              )}
            </form.Field>
            <FormError error={create.error} />
          </FieldGroup>
          <DialogFooter>
            <Button type="submit" loading={create.isPending}>
              Add agent
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
