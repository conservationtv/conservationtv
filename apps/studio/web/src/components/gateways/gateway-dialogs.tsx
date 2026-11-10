import type { FC, ReactNode } from 'react';
import { useForm } from '@tanstack/react-form';
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
import { GatewaySchema } from '@/forms/schemas';
import { SelectField } from '@/forms/select-field';
import { TextField } from '@/forms/text-field';
import { useDialog } from '@/hooks/use-dialog';
import { useOrganisationId } from '@/hooks/use-organisation';
import { useDeleteGateway, useUpdateGateway } from '@/queries/gateways';

// Changing and removing the organisation's own gateways (adding one is its own route, gateway-new): MediaMTX servers its agents run. The built-in gateway
// is never changed.

export interface GatewayUrlFieldsProps {
  /** A field for each protocol. */
  children: ReactNode;
}

/** The URL overrides, two to a row, under what they are for. */
export const GatewayUrlFields: FC<GatewayUrlFieldsProps> = ({ children }) => {
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
  const update = useUpdateGateway(organisationId);
  const form = useForm({
    defaultValues: gatewayInputOf(gateway),
    validators: { onSubmit: GatewaySchema },
    onSubmit: ({ value }) => dialog.mutate({ gatewayId: gateway.id, ...GatewaySchema.parse(value) })
  });
  const dialog = useDialog(update, { onOpen: () => form.reset() });
  return (
    <Dialog {...dialog.props}>
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
  const dialog = useDialog(remove);
  return (
    <AlertDialog {...dialog.props}>
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
          <AlertDialogAction variant="destructive" loading={remove.isPending} onClick={() => dialog.mutate(gateway.id)}>
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
