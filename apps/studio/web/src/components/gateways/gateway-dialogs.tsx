import { useState, type FC, type ReactNode } from 'react';
import { useForm } from '@tanstack/react-form';
import { PlusIcon } from '@phosphor-icons/react';
import type { Network } from '@conservationtv/studio-sdk';
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
import { FieldDescription, FieldGroup, FieldLegend, FieldSet } from '@conservationtv/ui/components/field';

import { FormError } from '@/components/common/form-error';
import { NetworkOptions } from '@/components/devices/network-options';
import { GATEWAY_PROTOCOLS, gatewayInputOf, type ListedGateway } from '@/components/gateways/gateways';
import { GatewaySchema, type GatewayInput } from '@/forms/schemas';
import { SelectField } from '@/forms/select-field';
import { TextField } from '@/forms/text-field';
import { useConfirm } from '@/hooks/use-confirm';
import { useOrganisationId } from '@/hooks/use-organisation';
import { useCreateGateway, useDeleteGateway, useUpdateGateway } from '@/queries/gateways';

// Adding, changing and removing the organisation's own gateways: MediaMTX servers its agents run. The built-in gateway
// is never changed.

const EMPTY_URLS: GatewayInput['urls'] = { webrtc: '', rtsp: '', rtsps: '', rtmp: '', rtmps: '', hls: '' };

export interface AddGatewayDialogProps {
  /** The networks the gateway can be on. */
  networks: Network[];
}

/** Adds a MediaMTX gateway on a network; the dialog closes once it is made. */
export const AddGatewayDialog: FC<AddGatewayDialogProps> = ({ networks }) => {
  const organisationId = useOrganisationId();
  const [open, setOpen] = useState(false);
  const create = useCreateGateway(organisationId);
  const defaultValues: GatewayInput = { name: '', networkId: networks[0]?.id ?? '', urls: EMPTY_URLS };
  const form = useForm({
    defaultValues,
    validators: { onSubmit: GatewaySchema },
    onSubmit: ({ value, formApi }) =>
      create.mutate(
        { kind: 'mediamtx', ...GatewaySchema.parse(value) },
        {
          onSuccess: () => {
            formApi.reset();
            setOpen(false);
          }
        }
      )
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
        Add gateway
      </DialogTrigger>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <form
          onSubmit={event => {
            event.preventDefault();
            form.handleSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Add a MediaMTX gateway</DialogTitle>
            <DialogDescription>
              A MediaMTX server on one of your networks, run by that network’s active agent. Streams delivered to it can
              be watched there without leaving the network.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-4">
            <form.Field name="name">
              {field => <TextField field={field} label="Name" placeholder="Hide MediaMTX" autoComplete="off" />}
            </form.Field>
            <form.Field name="networkId">
              {field => (
                <SelectField field={field} label="Network">
                  <NetworkOptions networks={networks} />
                </SelectField>
              )}
            </form.Field>
            <GatewayUrlFields>
              {GATEWAY_PROTOCOLS.map(({ protocol, label }) => (
                <form.Field key={protocol} name={`urls.${protocol}`}>
                  {field => <TextField field={field} label={label} autoComplete="off" spellCheck={false} />}
                </form.Field>
              ))}
            </GatewayUrlFields>
            <FormError error={create.error} />
          </FieldGroup>
          <DialogFooter>
            <Button type="submit" loading={create.isPending}>
              Add gateway
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

interface GatewayUrlFieldsProps {
  /** A field for each protocol. */
  children: ReactNode;
}

/** The URL overrides, two to a row, under what they are for. */
const GatewayUrlFields: FC<GatewayUrlFieldsProps> = ({ children }) => {
  return (
    <FieldSet>
      <FieldLegend variant="label">URL overrides</FieldLegend>
      <FieldDescription>
        Where each protocol’s server is reached, in place of what its agent registers: for a reverse proxy in front of
        it, say. Leave them empty to use what it registers.
      </FieldDescription>
      <div className="grid grid-cols-2 gap-4">{children}</div>
    </FieldSet>
  );
};

export interface GatewayDialogProps {
  gateway: ListedGateway;
}

export interface EditGatewayDialogProps extends GatewayDialogProps {
  networks: Network[];
}

/** Renames the gateway, moves it, or changes its URL overrides; the form starts from what is stored each time. */
export const EditGatewayDialog: FC<EditGatewayDialogProps> = ({ gateway, networks }) => {
  const organisationId = useOrganisationId();
  const [open, setOpen] = useState(false);
  const update = useUpdateGateway(organisationId);
  const form = useForm({
    defaultValues: gatewayInputOf(gateway),
    validators: { onSubmit: GatewaySchema },
    onSubmit: ({ value }) =>
      update.mutate({ gatewayId: gateway.id, ...GatewaySchema.parse(value) }, { onSuccess: () => setOpen(false) })
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
      <DialogTrigger render={<Button variant="ghost" size="sm" />}>Edit</DialogTrigger>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <form
          onSubmit={event => {
            event.preventDefault();
            form.handleSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle className="truncate">Edit {gateway.name}</DialogTitle>
            <DialogDescription>Its network’s active agent runs it.</DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-4">
            <form.Field name="name">{field => <TextField field={field} label="Name" autoComplete="off" />}</form.Field>
            <form.Field name="networkId">
              {field => (
                <SelectField field={field} label="Network">
                  <NetworkOptions networks={networks} />
                </SelectField>
              )}
            </form.Field>
            <GatewayUrlFields>
              {GATEWAY_PROTOCOLS.map(({ protocol, label }) => (
                <form.Field key={protocol} name={`urls.${protocol}`}>
                  {field => <TextField field={field} label={label} autoComplete="off" spellCheck={false} />}
                </form.Field>
              ))}
            </GatewayUrlFields>
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

/** Removes the gateway once confirmed. The API refuses while a stream is still delivered to it, and says so here. */
export const DeleteGatewayDialog: FC<GatewayDialogProps> = ({ gateway }) => {
  const organisationId = useOrganisationId();
  const remove = useDeleteGateway(organisationId);
  const confirmation = useConfirm(remove);
  return (
    <AlertDialog {...confirmation.dialog}>
      <AlertDialogTrigger render={<Button variant="ghost" size="sm" />}>Delete</AlertDialogTrigger>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle className="truncate">Delete {gateway.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            A gateway can only be deleted once no stream is delivered to it.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <FormError error={remove.error} />
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            loading={remove.isPending}
            onClick={() => confirmation.confirm(gateway.id)}
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
