import { Suspense, useState, type FC } from 'react';
import { useForm } from '@tanstack/react-form';
import { useSuspenseQueries, useSuspenseQuery } from '@tanstack/react-query';
import { HardDrivesIcon } from '@phosphor-icons/react';
import { Link, useNavigate } from 'react-router';
import type { Agent, Network } from '@conservationtv/studio-sdk';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger
} from '@conservationtv/ui/components/alert-dialog';
import { Badge } from '@conservationtv/ui/components/badge';
import { Button } from '@conservationtv/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from '@conservationtv/ui/components/dialog';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@conservationtv/ui/components/empty';
import { FieldGroup } from '@conservationtv/ui/components/field';
import { Skeleton } from '@conservationtv/ui/components/skeleton';

import type { Route } from './+types/agent';
import { AgentLive } from '@/components/agents/agent-live';
import { AgentSetup } from '@/components/agents/agent-setup';
import { PinButton } from '@/components/app/pins';
import { CopyButton } from '@/components/common/copy-button';
import { FormError } from '@/components/common/form-error';
import {
  BackLink,
  Fact,
  FactLabel,
  Facts,
  FactValue,
  Page,
  PageActions,
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
import { SubjectHealth } from '@/components/devices/subject-health';
import { deviceSubjectId, type SubjectState } from '@/components/devices/subjects';
import { AgentSettingsSchema, type AgentSettingsInput } from '@/forms/schemas';
import { TextField } from '@/forms/text-field';
import { useConfirm } from '@/hooks/use-confirm';
import { useIsAdministrator, useOrganisationId } from '@/hooks/use-organisation';
import { useUnpinPage } from '@/hooks/use-unpin-page';
import { formatDate, formatRelative, shortPublicId } from '@/lib/format';
import { agentListQueryOptions, useDeleteAgent, useUpdateAgent } from '@/queries/agents';
import { deviceAddressListQueryOptions, useUpdateDevice } from '@/queries/devices';
import { networkListQueryOptions, useSetActiveAgent } from '@/queries/networks';
import { showListQueryOptions } from '@/queries/shows';
import { subjectStateListQueryOptions } from '@/queries/streams';

export const meta: Route.MetaFunction = () => [{ title: 'Agent · conservation.tv studio' }];

/**
 * One agent: what the studio knows about it, and what it says about itself when asked directly. The studio's side (its
 * network, whether it is the active one, what it last reported) loads with the page; the live side is the agent's own
 * answer over iroh, in its own boundary, so a machine that is off doesn't hold the page up.
 */
const AgentRoute: FC<Route.ComponentProps> = ({ params }) => {
  const organisationId = useOrganisationId();
  const administrator = useIsAdministrator();
  const [agentsQuery, networksQuery, statesQuery, showsQuery] = useSuspenseQueries({
    queries: [
      agentListQueryOptions(organisationId),
      networkListQueryOptions(organisationId),
      subjectStateListQueryOptions(organisationId),
      showListQueryOptions(organisationId)
    ]
  });
  const agent = agentsQuery.data.find(candidate => candidate.id === params.agentId);
  if (!agent?.device) {
    return (
      <Page>
        <BackLink to=".." relative="path">
          Agents
        </BackLink>
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <HardDrivesIcon />
            </EmptyMedia>
            <EmptyTitle>Agent not found</EmptyTitle>
            <EmptyDescription>It may have been removed, or it belongs to another organisation.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </Page>
    );
  }
  const network = networksQuery.data.find(candidate => candidate.id === agent.networkId);
  return (
    <Page>
      <AgentHeader
        agent={agent}
        name={agent.device.name}
        network={network}
        state={statesQuery.data.find(state => state.subjectId === deviceSubjectId(agent.id))}
        show={showsQuery.data.find(show => show.output?.deviceId === agent.id)}
      />

      <Section>
        <SectionHeader>
          <SectionHeading>
            <SectionTitle>Right now</SectionTitle>
            <SectionDescription>
              Asked of the agent itself, from this browser, over an encrypted peer-to-peer connection.
            </SectionDescription>
          </SectionHeading>
        </SectionHeader>
        <Suspense fallback={<Skeleton className="h-40 w-full" />}>
          <AgentLive publicId={agent.device.publicId} />
        </Suspense>
      </Section>

      <Section>
        <SectionHeader>
          <SectionTitle>About</SectionTitle>
        </SectionHeader>
        <Facts>
          <Fact>
            <FactLabel>Network</FactLabel>
            <FactValue>{network?.name ?? 'Unknown'}</FactValue>
          </Fact>
          <Fact>
            <FactLabel>Priority</FactLabel>
            <FactValue>{agent.priority}</FactValue>
          </Fact>
          <Fact>
            <FactLabel>Added</FactLabel>
            <FactValue>{formatDate(agent.device.createdAt)}</FactValue>
          </Fact>
          <Fact>
            <FactLabel>Public ID</FactLabel>
            <FactValue className="flex items-center gap-1 font-mono text-custom-12">
              <span title={agent.device.publicId}>{shortPublicId(agent.device.publicId)}</span>
              <CopyButton value={agent.device.publicId} label="Copy public ID" />
            </FactValue>
          </Fact>
          <Suspense>
            <ReportedAddress agentId={agent.id} />
          </Suspense>
        </Facts>
      </Section>

      {administrator && (
        <>
          <Section>
            <SectionHeader>
              <SectionHeading>
                <SectionTitle>Run it</SectionTitle>
                <SectionDescription>
                  Start the agent on a machine at its site with this environment. One machine at a time: a second one
                  started with the same key takes over from the first.
                </SectionDescription>
              </SectionHeading>
            </SectionHeader>
            <AgentSetup agentId={agent.id} name={agent.device.name} />
          </Section>

          <Section>
            <SectionHeader>
              <SectionTitle>Manage</SectionTitle>
            </SectionHeader>
            <div className="flex flex-wrap items-center gap-2">
              <EditAgentDialog agent={agent} name={agent.device.name} />
              {!agent.active && <MakeActiveButton agent={agent} />}
              <DeleteAgentDialog agent={agent} name={agent.device.name} />
            </div>
          </Section>
        </>
      )}
    </Page>
  );
};

export default AgentRoute;

/** A show, as the agent's header names the one it sends out. */
interface OutputShow {
  id: string;
  name: string;
}

interface AgentHeaderProps {
  agent: Agent;
  name: string;
  network: Network | undefined;
  /** What has been reported to the studio about it: undefined when nothing has. */
  state: SubjectState | undefined;
  /** The show this agent sends out, if it is one's output. */
  show: OutputShow | undefined;
}

/** The way back, the agent's name with how it is doing and what it is for, and its pin. */
const AgentHeader: FC<AgentHeaderProps> = ({ agent, name, network, state, show }) => {
  const site = network?.name ?? 'its network';
  return (
    <>
      <BackLink to=".." relative="path">
        Agents
      </BackLink>
      <PageHeader>
        <PageHeading>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <PageTitle>{name}</PageTitle>
            <SubjectHealth state={state} />
            {agent.active ? <Badge variant="secondary">Active</Badge> : <Badge variant="outline">Standby</Badge>}
            {show && (
              <Badge variant="outline" render={<Link to={`../../shows/${show.id}`} relative="path" />}>
                Sends {show.name} out
              </Badge>
            )}
          </div>
          <PageDescription>
            {agent.active ? `Delivering the streams of ${site}.` : `Standing by on ${site}.`}
          </PageDescription>
        </PageHeading>
        <PageActions>
          <PinButton label={name} kind="agent" />
        </PageActions>
      </PageHeader>
    </>
  );
};

interface AgentIdProps {
  agentId: string;
}

/** Where the agent last told the studio it can be reached on its own network; nothing if it has never said. */
const ReportedAddress: FC<AgentIdProps> = ({ agentId }) => {
  const organisationId = useOrganisationId();
  const addressesQuery = useSuspenseQuery(deviceAddressListQueryOptions(organisationId, agentId));
  const address = addressesQuery.data.find(candidate => candidate.preferred) ?? addressesQuery.data[0];
  if (!address) return null;
  return (
    <Fact>
      <FactLabel>Reported address</FactLabel>
      <FactValue title={`Reported ${formatRelative(address.reportedAt)}`}>{address.address}</FactValue>
    </Fact>
  );
};

interface AgentActionProps {
  agent: Agent;
}

/** Makes this agent its network's active one, in place of whichever is. */
const MakeActiveButton: FC<AgentActionProps> = ({ agent }) => {
  const organisationId = useOrganisationId();
  const setActive = useSetActiveAgent(organisationId);
  return (
    <>
      <Button
        variant="outline"
        loading={setActive.isPending}
        onClick={() => setActive.mutate({ networkId: agent.networkId, agentId: agent.id })}
      >
        Make active
      </Button>
      <FormError error={setActive.error} />
    </>
  );
};

interface EditAgentDialogProps extends AgentActionProps {
  name: string;
}

/**
 * Edits what an administrator may change: the agent's name, which is its device's, and its priority, which is its own.
 * Only what changed is sent, the name first. An agent's network can't change: it is added to the one it runs on.
 */
const EditAgentDialog: FC<EditAgentDialogProps> = ({ agent, name }) => {
  const organisationId = useOrganisationId();
  const [open, setOpen] = useState(false);
  const updateDevice = useUpdateDevice(organisationId);
  const updateAgent = useUpdateAgent(organisationId);
  const defaultValues: AgentSettingsInput = { name, priority: String(agent.priority) };
  const form = useForm({
    defaultValues,
    validators: { onSubmit: AgentSettingsSchema },
    onSubmit: async ({ value }) => {
      const settings = AgentSettingsSchema.parse(value);
      if (settings.name !== name) await updateDevice.mutateAsync({ deviceId: agent.id, name: settings.name });
      if (settings.priority !== agent.priority) {
        await updateAgent.mutateAsync({ agentId: agent.id, priority: settings.priority });
      }
      setOpen(false);
    }
  });
  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        setOpen(next);
        if (!next) return;
        updateDevice.reset();
        updateAgent.reset();
        form.reset();
      }}
    >
      <DialogTrigger render={<Button variant="outline" />}>Edit</DialogTrigger>
      <DialogContent>
        <form
          onSubmit={event => {
            event.preventDefault();
            // A refused save is shown from the mutation that refused it.
            form.handleSubmit().catch(() => undefined);
          }}
        >
          <DialogHeader>
            <DialogTitle>Edit {name}</DialogTitle>
          </DialogHeader>
          <FieldGroup className="py-4">
            <form.Field name="name">{field => <TextField field={field} label="Name" autoComplete="off" />}</form.Field>
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
            <FormError error={updateDevice.error ?? updateAgent.error} />
          </FieldGroup>
          <DialogFooter>
            <Button type="submit" loading={updateDevice.isPending || updateAgent.isPending}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

interface DeleteAgentDialogProps extends AgentActionProps {
  name: string;
}

/** Removes the agent and its identity once confirmed, then goes back to the list. */
const DeleteAgentDialog: FC<DeleteAgentDialogProps> = ({ agent, name }) => {
  const organisationId = useOrganisationId();
  const navigate = useNavigate();
  const remove = useDeleteAgent(organisationId);
  const confirmation = useConfirm(remove);
  const unpin = useUnpinPage();
  return (
    <AlertDialog {...confirmation.dialog}>
      <AlertDialogTrigger render={<Button variant="destructive" />}>Remove agent</AlertDialogTrigger>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>Remove {name}?</AlertDialogTitle>
          <AlertDialogDescription>
            Its identity is deleted with it, so a machine still running it is refused from then on. It can’t be removed
            while a stream is published by it, or while it sends the show out.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <FormError error={remove.error} />
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            loading={remove.isPending}
            onClick={() =>
              confirmation.confirm(agent.id, {
                onSuccess: () => {
                  unpin();
                  navigate('..', { relative: 'path', replace: true });
                }
              })
            }
          >
            Remove
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
