import type { FC, ReactNode } from 'react';
import { useForm } from '@tanstack/react-form';
import { PlusIcon } from '@phosphor-icons/react';
import type { Camera, Device, Network, Rendition, Stream } from '@conservationtv/studio-sdk';
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
import { RenditionsField } from '@/components/streams/renditions-field';
import { renditionChoices, sourceRenditions } from '@/components/streams/renditions';
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
// another of its exposures, offering some of the renditions what feeds it offers. The API checks the chain (no loops,
// no rendition its upstream lacks, nothing removed from under what depends on it) and its refusals show in place.

/** What a delivery's form chooses from: the stream, the gateways it can go to, and the devices that can send it. */
export interface ExposureChoices {
  stream: Stream;
  gateways: ListedGateway[];
  networks: Network[];
  devices: Device[];
  /** The stream's source, when it is a camera: what it can produce limits what its first deliveries offer. */
  sourceCamera: Camera | undefined;
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
    renditions: ['default'],
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
    renditions: exposure.renditions,
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

/** A delivery's fields: its gateway, what feeds it, the renditions it offers, and who sends it. */
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
        <form.Field
          name="upstreamExposureId"
          listeners={{
            // What the new upstream doesn't offer is unticked with its checkbox, which disappears; left with nothing,
            // the delivery takes the first rendition it can.
            onChange: ({ value }) => {
              const offered = renditionChoices(availableFrom(choices, value));
              const kept = form.getFieldValue('renditions').filter(rendition => offered.includes(rendition));
              form.setFieldValue('renditions', kept.length > 0 ? kept : offered.slice(0, 1));
            }
          }}
        >
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
        <form.Subscribe selector={state => state.values.upstreamExposureId}>
          {upstreamId => (
            <form.Field name="renditions">
              {field => (
                <RenditionsField
                  field={field}
                  label="Renditions"
                  choices={renditionChoices(availableFrom(choices, upstreamId), exposure?.renditions)}
                  description={renditionsNote(choices, upstreamId)}
                />
              )}
            </form.Field>
          )}
        </form.Subscribe>
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

/** The renditions what feeds a delivery offers: its upstream's, or what the source can produce. */
function availableFrom(choices: ExposureChoices, upstreamId: string): Rendition[] {
  const upstream = choices.stream.exposures.find(candidate => candidate.id === upstreamId);
  return upstream ? upstream.renditions : sourceRenditions(choices.sourceCamera);
}

/** Why the choice of renditions is what it is, when it is narrower than all of them. */
function renditionsNote(choices: ExposureChoices, upstreamId: string): string | undefined {
  if (upstreamId !== '') return 'At most what it is fed.';
  if (choices.sourceCamera?.settings.driver === 'rtsp') return 'A plain RTSP camera gives only its source, as it is.';
  return undefined;
}

function gatewayName(gateways: ListedGateway[], gatewayId: string): string {
  return gateways.find(gateway => gateway.id === gatewayId)?.name ?? 'Unknown gateway';
}
