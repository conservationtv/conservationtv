import type { FC, ReactNode } from 'react';
import { useForm } from '@tanstack/react-form';
import { PlusIcon } from '@phosphor-icons/react';
import type { Device, Network, Stream } from '@conservationtv/studio-sdk';
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
import { FieldGroup } from '@conservationtv/ui/components/field';
import { NativeSelectOptGroup, NativeSelectOption } from '@conservationtv/ui/components/native-select';

import { FormError } from '@/components/common/form-error';
import { PublisherOptions } from '@/components/streams/publisher-options';
import {
  gatewayGroups,
  upstreamChoices,
  type Delivery,
  type ListedGateway,
  type StreamExposure
} from '@/components/streams/stream-detail';
import { ExposureSchema, type Exposure, type ExposureInput } from '@/forms/schemas';
import { SelectField } from '@/forms/select-field';
import { useDialog } from '@/hooks/use-dialog';
import { useOrganisationId } from '@/hooks/use-organisation';
import { useCreateExposure, useDeleteExposure, useUpdateExposure } from '@/queries/streams';

// Adding, changing and removing a stream's deliveries: its exposures, each to one gateway, fed by its source or by
// another of its exposures, carrying the picture its source gives. The API checks the chain (no loops, nothing removed
// from under what depends on it) and its refusals show in place.

/** What a delivery's form chooses from: the stream, the gateways it can go to, and the devices that can send it. */
export interface ExposureChoices {
  stream: Stream;
  gateways: ListedGateway[];
  networks: Network[];
  devices: Device[];
  /** The source device's name, for "fed by". */
  sourceName: string | undefined;
}

export interface AddExposureDialogProps {
  choices: ExposureChoices;
}

/** Delivers the stream to another gateway; the dialog closes once the exposure is made. */
export const AddExposureDialog: FC<AddExposureDialogProps> = ({ choices }) => {
  const organisationId = useOrganisationId();
  const create = useCreateExposure(organisationId);
  const defaultValues: ExposureInput = {
    gatewayId: '',
    upstreamExposureId: '',
    publisherDeviceId: ''
  };
  const dialog = useDialog(create);
  return (
    <Dialog {...dialog.props}>
      <DialogTrigger render={<Button variant="outline" />}>
        <PlusIcon />
        Add delivery
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a delivery</DialogTitle>
          <DialogDescription>
            Send {choices.stream.name} to a gateway, where it can be read: on one of your networks, or on the internet.
          </DialogDescription>
        </DialogHeader>
        <ExposureForm
          choices={choices}
          defaultValues={defaultValues}
          onSubmit={exposure => dialog.mutate({ streamId: choices.stream.id, ...exposure })}
        >
          <FormError error={create.error} />
          <DialogFooter>
            <Button type="submit" loading={create.isPending}>
              Add delivery
            </Button>
          </DialogFooter>
        </ExposureForm>
      </DialogContent>
    </Dialog>
  );
};

export interface ExposureDialogProps {
  choices: ExposureChoices;
  delivery: Delivery;
}

/** Changes a delivery; the form starts from what is stored each time the dialog opens. */
export const EditExposureDialog: FC<ExposureDialogProps> = ({ choices, delivery }) => {
  const organisationId = useOrganisationId();
  const update = useUpdateExposure(organisationId);
  const { exposure } = delivery;
  const defaultValues: ExposureInput = {
    gatewayId: exposure.gatewayId,
    upstreamExposureId: exposure.upstreamExposureId ?? '',
    publisherDeviceId: exposure.publisherDeviceId ?? ''
  };
  const dialog = useDialog(update);
  return (
    <Dialog {...dialog.props}>
      <DialogTrigger render={<Button variant="ghost" size="sm" />}>Edit</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit the delivery to {delivery.name}</DialogTitle>
        </DialogHeader>
        {/* Mounted only while open, so it starts from what is stored each time. */}
        <ExposureForm
          choices={choices}
          exposure={exposure}
          defaultValues={defaultValues}
          onSubmit={changes => dialog.mutate({ streamId: choices.stream.id, exposureId: exposure.id, ...changes })}
        >
          <FormError error={update.error} />
          <DialogFooter>
            <Button type="submit" loading={update.isPending}>
              Save
            </Button>
          </DialogFooter>
        </ExposureForm>
      </DialogContent>
    </Dialog>
  );
};

/** Stops the delivery once confirmed. The API refuses while a delivery or a recorder depends on it, and says so here. */
export const DeleteExposureDialog: FC<ExposureDialogProps> = ({ choices, delivery }) => {
  const organisationId = useOrganisationId();
  const remove = useDeleteExposure(organisationId);
  const dialog = useDialog(remove);
  return (
    <AlertDialog {...dialog.props}>
      <AlertDialogTrigger render={<Button variant="ghost" size="sm" />}>Remove</AlertDialogTrigger>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>Stop delivering to {delivery.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            Readers there lose the stream. A delivery can’t be removed while another is fed from it or a recorder
            records it.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <FormError error={remove.error} />
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            loading={remove.isPending}
            onClick={() => dialog.mutate({ streamId: choices.stream.id, partId: delivery.exposure.id })}
          >
            Remove
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};

interface ExposureFormProps {
  choices: ExposureChoices;
  /** The exposure being changed, if it exists yet: it can't be fed by itself or anything it feeds. */
  exposure?: StreamExposure;
  defaultValues: ExposureInput;
  onSubmit: (exposure: Exposure) => void;
  /** What follows the fields: the dialog's error and footer. */
  children: ReactNode;
}

/** A delivery's fields: its gateway, what feeds it, and who sends it. */
const ExposureForm: FC<ExposureFormProps> = ({ choices, exposure, defaultValues, onSubmit, children }) => {
  const form = useForm({
    defaultValues,
    validators: { onSubmit: ExposureSchema },
    onSubmit: ({ value }) => onSubmit(ExposureSchema.parse(value))
  });
  const upstreams = upstreamChoices(choices.stream, exposure?.id);
  return (
    <form
      onSubmit={event => {
        event.preventDefault();
        form.handleSubmit();
      }}
    >
      <FieldGroup className="py-4">
        <form.Field name="gatewayId">
          {field => (
            <SelectField field={field} label="Gateway">
              <NativeSelectOption value="" disabled>
                Choose a gateway
              </NativeSelectOption>
              {gatewayGroups(choices.gateways, choices.networks).map(group => (
                <NativeSelectOptGroup key={group.label} label={group.label}>
                  {group.gateways.map(gateway => (
                    <NativeSelectOption key={gateway.id} value={gateway.id}>
                      {gateway.name}
                    </NativeSelectOption>
                  ))}
                </NativeSelectOptGroup>
              ))}
            </SelectField>
          )}
        </form.Field>
        <form.Field name="upstreamExposureId">
          {field => (
            <SelectField field={field} label="Fed by">
              <NativeSelectOption value="">{choices.sourceName ?? 'Its publisher'} (the source)</NativeSelectOption>
              {upstreams.map(upstream => (
                <NativeSelectOption key={upstream.id} value={upstream.id}>
                  {gatewayName(choices.gateways, upstream.gatewayId)}
                </NativeSelectOption>
              ))}
            </SelectField>
          )}
        </form.Field>
        <form.Field name="publisherDeviceId">
          {field => (
            <SelectField
              field={field}
              label="Published by"
              description="Left to the system, a network’s active agent sends to its own MediaMTX gateway. Anywhere else needs a device pinned here."
            >
              <NativeSelectOption value="">Chosen by the system</NativeSelectOption>
              <PublisherOptions devices={choices.devices} />
            </SelectField>
          )}
        </form.Field>
        {children}
      </FieldGroup>
    </form>
  );
};

function gatewayName(gateways: ListedGateway[], gatewayId: string): string {
  return gateways.find(gateway => gateway.id === gatewayId)?.name ?? 'Unknown gateway';
}
