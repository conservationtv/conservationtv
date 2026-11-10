import { useState, type FC } from 'react';
import { useForm } from '@tanstack/react-form';
import { useSuspenseQueries } from '@tanstack/react-query';
import { NetworkIcon, PlusIcon } from '@phosphor-icons/react';
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
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@conservationtv/ui/components/empty';
import { FieldGroup } from '@conservationtv/ui/components/field';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemGroup,
  ItemMedia,
  ItemTitle
} from '@conservationtv/ui/components/item';
import { NativeSelect, NativeSelectOption } from '@conservationtv/ui/components/native-select';

import type { Route } from './+types/networks';
import { FormError } from '@/components/common/form-error';
import { Page, PageActions, PageDescription, PageHeader, PageHeading, PageTitle } from '@/components/common/page';
import { NameSchema, type NameInput } from '@/forms/schemas';
import { TextField } from '@/forms/text-field';
import { useConfirm } from '@/hooks/use-confirm';
import { useIsAdministrator, useOrganisationId } from '@/hooks/use-organisation';
import { counted } from '@/lib/format';
import { agentListQueryOptions } from '@/queries/agents';
import { cameraListQueryOptions } from '@/queries/cameras';
import { gatewayListQueryOptions } from '@/queries/gateways';
import {
  networkListQueryOptions,
  useCreateNetwork,
  useDeleteNetwork,
  useSetActiveAgent,
  useUpdateNetwork
} from '@/queries/networks';

export const meta: Route.MetaFunction = () => [{ title: 'Networks · conservation.tv studio' }];

/**
 * An organisation's networks: the sites its cameras and agents are on. Each lists what is on it, and which of its
 * agents is active, the one delivering its streams. Everyone reads them; administrators add, rename and remove them and
 * choose the active agent.
 */
const NetworksRoute: FC = () => {
  const organisationId = useOrganisationId();
  const administrator = useIsAdministrator();
  const [networksQuery, agentsQuery, camerasQuery, gatewaysQuery] = useSuspenseQueries({
    queries: [
      networkListQueryOptions(organisationId),
      agentListQueryOptions(organisationId),
      cameraListQueryOptions(organisationId),
      gatewayListQueryOptions(organisationId)
    ]
  });
  const networks = networksQuery.data;
  return (
    <Page>
      <PageHeader>
        <PageHeading>
          <PageTitle>Networks</PageTitle>
          <PageDescription>
            The sites your cameras and agents are on. One agent on each network is active: it pulls from the cameras
            there and delivers their streams.
          </PageDescription>
        </PageHeading>
        {administrator && (
          <PageActions>
            <AddNetworkDialog />
          </PageActions>
        )}
      </PageHeader>
      {networks.length > 0 ? (
        <ItemGroup className="gap-2">
          {networks.map(network => (
            <NetworkRow
              key={network.id}
              network={network}
              agents={agentsQuery.data.filter(agent => agent.networkId === network.id)}
              cameraCount={camerasQuery.data.filter(camera => camera.device?.networkId === network.id).length}
              gatewayCount={gatewaysQuery.data.filter(gateway => gateway.networkId === network.id).length}
            />
          ))}
        </ItemGroup>
      ) : (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <NetworkIcon />
            </EmptyMedia>
            <EmptyTitle>No networks yet</EmptyTitle>
            <EmptyDescription>Add the site your cameras are on, then put an agent on it.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </Page>
  );
};

export default NetworksRoute;

interface NetworkRowProps {
  network: Network;
  /** The agents on this network. */
  agents: Agent[];
  cameraCount: number;
  gatewayCount: number;
}

/** A network: what is on it, its active agent, and for administrators, renaming and removing it. */
const NetworkRow: FC<NetworkRowProps> = ({ network, agents, cameraCount, gatewayCount }) => {
  const administrator = useIsAdministrator();
  const active = agents.find(agent => agent.id === network.activeAgent?.id);
  return (
    <Item variant="outline">
      <ItemMedia variant="icon">
        <NetworkIcon />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{network.name}</ItemTitle>
        <ItemDescription>
          {counted(cameraCount, 'camera')} · {counted(agents.length, 'agent')} · {counted(gatewayCount, 'gateway')}
        </ItemDescription>
      </ItemContent>
      {administrator && (
        <ItemActions>
          <RenameNetworkDialog network={network} />
          <DeleteNetworkDialog network={network} />
        </ItemActions>
      )}
      <ItemFooter className="justify-start gap-3 border-t border-border pt-2.5">
        <span className="text-custom-12 text-custom-text-secondary">Active agent</span>
        {administrator ? (
          <ActiveAgentSelect network={network} agents={agents} />
        ) : (
          <span className="text-custom-12 text-foreground">{active?.device?.name ?? 'None'}</span>
        )}
      </ItemFooter>
    </Item>
  );
};

interface ActiveAgentSelectProps {
  network: Network;
  agents: Agent[];
}

/** Chooses the network's active agent from the agents on it, or none. Shows the choice being saved until it is. */
const ActiveAgentSelect: FC<ActiveAgentSelectProps> = ({ network, agents }) => {
  const organisationId = useOrganisationId();
  const setActive = useSetActiveAgent(organisationId);
  const stored = network.activeAgent?.id ?? '';
  const value = setActive.isPending ? (setActive.variables.agentId ?? '') : stored;
  return (
    <>
      <NativeSelect
        size="sm"
        aria-label={`Active agent on ${network.name}`}
        value={value}
        disabled={setActive.isPending || agents.length === 0}
        onChange={event => setActive.mutate({ networkId: network.id, agentId: event.target.value || null })}
      >
        <NativeSelectOption value="">None</NativeSelectOption>
        {agents.map(agent => (
          <NativeSelectOption key={agent.id} value={agent.id}>
            {agent.device?.name ?? 'Unnamed agent'}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <FormError error={setActive.error} />
    </>
  );
};

/** Adds a network by name; the dialog closes once it is made. */
const AddNetworkDialog: FC = () => {
  const organisationId = useOrganisationId();
  const [open, setOpen] = useState(false);
  const create = useCreateNetwork(organisationId);
  const defaultValues: NameInput = { name: '' };
  const form = useForm({
    defaultValues,
    validators: { onSubmit: NameSchema },
    onSubmit: ({ value, formApi }) =>
      create.mutate(NameSchema.parse(value), {
        onSuccess: () => {
          formApi.reset();
          setOpen(false);
        }
      })
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
        Add network
      </DialogTrigger>
      <DialogContent>
        <form
          onSubmit={event => {
            event.preventDefault();
            form.handleSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Add a network</DialogTitle>
            <DialogDescription>
              A site with its own local network: a sanctuary, a reserve, a single building.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-4">
            <form.Field name="name">
              {field => <TextField field={field} label="Name" placeholder="Hide LAN" autoComplete="off" />}
            </form.Field>
            <FormError error={create.error} />
          </FieldGroup>
          <DialogFooter>
            <Button type="submit" loading={create.isPending}>
              Add network
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

interface NetworkDialogProps {
  network: Network;
}

/** Renames the network; the form starts from its stored name each time the dialog opens. */
const RenameNetworkDialog: FC<NetworkDialogProps> = ({ network }) => {
  const organisationId = useOrganisationId();
  const [open, setOpen] = useState(false);
  const update = useUpdateNetwork(organisationId);
  const defaultValues: NameInput = { name: network.name };
  const form = useForm({
    defaultValues,
    validators: { onSubmit: NameSchema },
    onSubmit: ({ value }) =>
      update.mutate({ networkId: network.id, ...NameSchema.parse(value) }, { onSuccess: () => setOpen(false) })
  });
  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        setOpen(next);
        if (!next) return;
        update.reset();
        form.reset();
      }}
    >
      <DialogTrigger render={<Button variant="ghost" size="sm" />}>Rename</DialogTrigger>
      <DialogContent>
        <form
          onSubmit={event => {
            event.preventDefault();
            form.handleSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Rename {network.name}</DialogTitle>
          </DialogHeader>
          <FieldGroup className="py-4">
            <form.Field name="name">{field => <TextField field={field} label="Name" autoComplete="off" />}</form.Field>
            <FormError error={update.error} />
          </FieldGroup>
          <DialogFooter>
            <Button type="submit" loading={update.isPending}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

/** Removes the network once confirmed. The API refuses while anything is still on it, and says so here. */
const DeleteNetworkDialog: FC<NetworkDialogProps> = ({ network }) => {
  const organisationId = useOrganisationId();
  const remove = useDeleteNetwork(organisationId);
  const confirmation = useConfirm(remove);
  return (
    <AlertDialog {...confirmation.dialog}>
      <AlertDialogTrigger render={<Button variant="ghost" size="sm" />}>Delete</AlertDialogTrigger>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {network.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            A network can only be deleted once its cameras, agents and gateways have been moved or removed.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <FormError error={remove.error} />
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            loading={remove.isPending}
            onClick={() => confirmation.confirm(network.id)}
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
