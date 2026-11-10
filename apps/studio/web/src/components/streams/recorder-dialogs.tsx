import { useState, type FC, type ReactNode } from 'react';
import { useForm } from '@tanstack/react-form';
import { PlusIcon } from '@phosphor-icons/react';
import type { Rendition } from '@conservationtv/studio-sdk';
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
import { NativeSelectOption } from '@conservationtv/ui/components/native-select';

import { FormError } from '@/components/common/form-error';
import { renditionChoices, renditionLabels } from '@/components/streams/renditions';
import type { Delivery, StreamRecorder } from '@/components/streams/stream-detail';
import { RecorderSchema, type Recorder, type RecorderInput } from '@/forms/schemas';
import { SelectField } from '@/forms/select-field';
import { TextField } from '@/forms/text-field';
import { useConfirm } from '@/hooks/use-confirm';
import { useOrganisationId } from '@/hooks/use-organisation';
import { useCreateRecorder, useDeleteRecorder, useUpdateRecorder } from '@/queries/streams';

// Adding, changing and removing a stream's recorders: each records one of its deliveries at one of the renditions that
// delivery offers. The API keeps them consistent (a delivery can't stop offering what is recorded of it); nothing acts
// on a recorder yet, which the page says where it lists them.

export interface AddRecorderDialogProps {
  streamId: string;
  /** The stream's deliveries, any of which can be recorded. */
  deliveries: Delivery[];
}

/** Records one of the stream's deliveries; the dialog closes once the recorder is made. */
export const AddRecorderDialog: FC<AddRecorderDialogProps> = ({ streamId, deliveries }) => {
  const organisationId = useOrganisationId();
  const [open, setOpen] = useState(false);
  const create = useCreateRecorder(organisationId);
  const first = deliveries[0]?.exposure;
  const defaultValues: RecorderInput = {
    exposureId: first?.id ?? '',
    rendition: first?.renditions[0] ?? 'default',
    kind: ''
  };
  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        setOpen(next);
        if (!next) create.reset();
      }}
    >
      <DialogTrigger render={<Button variant="outline" disabled={deliveries.length === 0} />}>
        <PlusIcon />
        Add recorder
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a recorder</DialogTitle>
          <DialogDescription>Choose a delivery to record, and the rendition of it to keep.</DialogDescription>
        </DialogHeader>
        <RecorderForm
          deliveries={deliveries}
          defaultValues={defaultValues}
          onSubmit={recorder => create.mutate({ streamId, ...recorder }, { onSuccess: () => setOpen(false) })}
        >
          <FormError error={create.error} />
          <DialogFooter>
            <Button type="submit" loading={create.isPending}>
              Add recorder
            </Button>
          </DialogFooter>
        </RecorderForm>
      </DialogContent>
    </Dialog>
  );
};

export interface RecorderDialogProps {
  streamId: string;
  recorder: StreamRecorder;
  deliveries: Delivery[];
}

/** Changes what a recorder records, or its kind; the form starts from what is stored each time the dialog opens. */
export const EditRecorderDialog: FC<RecorderDialogProps> = ({ streamId, recorder, deliveries }) => {
  const organisationId = useOrganisationId();
  const [open, setOpen] = useState(false);
  const update = useUpdateRecorder(organisationId);
  const defaultValues: RecorderInput = {
    exposureId: recorder.exposureId,
    rendition: recorder.rendition,
    kind: recorder.kind
  };
  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        setOpen(next);
        if (next) update.reset();
      }}
    >
      <DialogTrigger render={<Button variant="ghost" size="sm" />}>Edit</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit the recorder</DialogTitle>
        </DialogHeader>
        {/* Mounted only while open, so it starts from what is stored each time. */}
        <RecorderForm
          deliveries={deliveries}
          recorder={recorder}
          defaultValues={defaultValues}
          onSubmit={changes =>
            update.mutate({ streamId, recorderId: recorder.id, ...changes }, { onSuccess: () => setOpen(false) })
          }
        >
          <FormError error={update.error} />
          <DialogFooter>
            <Button type="submit" loading={update.isPending}>
              Save
            </Button>
          </DialogFooter>
        </RecorderForm>
      </DialogContent>
    </Dialog>
  );
};

export interface DeleteRecorderDialogProps {
  streamId: string;
  recorder: StreamRecorder;
}

/** Removes the recorder once confirmed. */
export const DeleteRecorderDialog: FC<DeleteRecorderDialogProps> = ({ streamId, recorder }) => {
  const organisationId = useOrganisationId();
  const remove = useDeleteRecorder(organisationId);
  const confirmation = useConfirm(remove);
  return (
    <AlertDialog {...confirmation.dialog}>
      <AlertDialogTrigger render={<Button variant="ghost" size="sm" />}>Remove</AlertDialogTrigger>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>Remove this recorder?</AlertDialogTitle>
          <AlertDialogDescription>The delivery it records carries on as it is.</AlertDialogDescription>
        </AlertDialogHeader>
        <FormError error={remove.error} />
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            loading={remove.isPending}
            onClick={() => confirmation.confirm({ streamId, partId: recorder.id })}
          >
            Remove
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};

interface RecorderFormProps {
  deliveries: Delivery[];
  /** The recorder being changed, if it exists yet: the rendition it records stays a choice. */
  recorder?: StreamRecorder;
  defaultValues: RecorderInput;
  onSubmit: (recorder: Recorder) => void;
  /** What follows the fields: the dialog's error and footer. */
  children: ReactNode;
}

/** A recorder's fields: the delivery it records, the rendition of it, and its kind. */
const RecorderForm: FC<RecorderFormProps> = ({ deliveries, recorder, defaultValues, onSubmit, children }) => {
  const form = useForm({
    defaultValues,
    validators: { onSubmit: RecorderSchema },
    onSubmit: ({ value }) => onSubmit(RecorderSchema.parse(value))
  });
  return (
    <form
      onSubmit={event => {
        event.preventDefault();
        form.handleSubmit();
      }}
    >
      <FieldGroup className="py-4">
        <form.Field
          name="exposureId"
          listeners={{
            // A rendition the newly chosen delivery doesn't offer gives way to the first one it does.
            onChange: ({ value }) => {
              const offered = offeredBy(deliveries, value, recorder?.rendition);
              const rendition = form.getFieldValue('rendition');
              if (!offered.includes(rendition) && offered[0]) form.setFieldValue('rendition', offered[0]);
            }
          }}
        >
          {field => (
            <SelectField field={field} label="Delivery">
              {deliveries.map(delivery => (
                <NativeSelectOption key={delivery.exposure.id} value={delivery.exposure.id}>
                  {delivery.name}
                </NativeSelectOption>
              ))}
            </SelectField>
          )}
        </form.Field>
        <form.Subscribe selector={state => state.values.exposureId}>
          {exposureId => (
            <form.Field name="rendition">
              {field => (
                <SelectField field={field} label="Rendition" description="One the delivery offers.">
                  {offeredBy(deliveries, exposureId, recorder?.rendition).map(rendition => (
                    <NativeSelectOption key={rendition} value={rendition}>
                      {renditionLabels[rendition]}
                    </NativeSelectOption>
                  ))}
                </SelectField>
              )}
            </form.Field>
          )}
        </form.Subscribe>
        <form.Field name="kind">
          {field => (
            <TextField
              field={field}
              label="Kind"
              description="The name of the recording implementation that should act on it."
              autoComplete="off"
            />
          )}
        </form.Field>
        {children}
      </FieldGroup>
    </form>
  );
};

/** The renditions the chosen delivery offers, and the one a recorder records now, so an edit never hides it. */
function offeredBy(deliveries: Delivery[], exposureId: string, recorded: Rendition | undefined): Rendition[] {
  const delivery = deliveries.find(candidate => candidate.exposure.id === exposureId);
  return renditionChoices(delivery?.exposure.renditions ?? [], recorded ? [recorded] : []);
}
