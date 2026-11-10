import type { FC } from 'react';
import { useForm } from '@tanstack/react-form';
import { useNavigate } from 'react-router';
import type { Camera, Device, Stream } from '@conservationtv/studio-sdk';
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
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from '@conservationtv/ui/components/dialog';
import { FieldGroup } from '@conservationtv/ui/components/field';
import { NativeSelect, NativeSelectOption } from '@conservationtv/ui/components/native-select';

import { FormError } from '@/components/common/form-error';
import { NameSchema, type NameInput } from '@/forms/schemas';
import { TextField } from '@/forms/text-field';
import { useDialog } from '@/hooks/use-dialog';
import { useOrganisationId } from '@/hooks/use-organisation';
import { useUnpinPage } from '@/hooks/use-unpin-page';
import { useDeleteStream, useUpdateStream } from '@/queries/streams';

// What an administrator changes about a stream itself, beside its deliveries and recorders: its name, its source, and
// whether it exists.

export interface StreamDialogProps {
  stream: Stream;
}

/** Renames the stream; the form starts from its stored name each time the dialog opens. */
export const RenameStreamDialog: FC<StreamDialogProps> = ({ stream }) => {
  const organisationId = useOrganisationId();
  const update = useUpdateStream(organisationId);
  const defaultValues: NameInput = { name: stream.name };
  const form = useForm({
    defaultValues,
    validators: { onSubmit: NameSchema },
    onSubmit: ({ value }) => dialog.mutate({ streamId: stream.id, ...NameSchema.parse(value) })
  });
  const dialog = useDialog(update, { onOpen: () => form.reset() });
  return (
    <Dialog {...dialog.props}>
      <DialogTrigger render={<Button variant="ghost" size="sm" />}>Rename</DialogTrigger>
      <DialogContent>
        <form
          onSubmit={event => {
            event.preventDefault();
            form.handleSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Rename {stream.name}</DialogTitle>
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

export interface SourceSelectProps {
  stream: Stream;
  cameras: Camera[];
  /** The current source, when it is a device other than a camera, so it stays a choice. */
  source: Device | undefined;
}

/**
 * Chooses the camera the stream comes from, or none, when something else publishes it. Shows the choice being saved
 * until it is. The stream keeps its deliveries when its camera changes.
 */
export const SourceSelect: FC<SourceSelectProps> = ({ stream, cameras, source }) => {
  const organisationId = useOrganisationId();
  const update = useUpdateStream(organisationId);
  const stored = stream.sourceDeviceId ?? '';
  const value = update.isPending ? (update.variables.sourceDeviceId ?? '') : stored;
  const otherSource = source && !cameras.some(camera => camera.id === source.id) ? source : undefined;
  return (
    <>
      <NativeSelect
        size="sm"
        aria-label={`Source of ${stream.name}`}
        value={value}
        disabled={update.isPending}
        onChange={event => update.mutate({ streamId: stream.id, sourceDeviceId: event.target.value || null })}
      >
        <NativeSelectOption value="">None: published to it</NativeSelectOption>
        {otherSource && <NativeSelectOption value={otherSource.id}>{otherSource.name}</NativeSelectOption>}
        {cameras.map(camera => (
          <NativeSelectOption key={camera.id} value={camera.id}>
            {camera.device?.name ?? 'Unnamed camera'}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <FormError error={update.error} />
    </>
  );
};

/** Deletes the stream, its deliveries and recorders, once confirmed, then goes back to the list. */
export const DeleteStreamDialog: FC<StreamDialogProps> = ({ stream }) => {
  const organisationId = useOrganisationId();
  const navigate = useNavigate();
  const remove = useDeleteStream(organisationId);
  const dialog = useDialog(remove);
  const unpin = useUnpinPage();
  return (
    <AlertDialog {...dialog.props}>
      <AlertDialogTrigger render={<Button variant="destructive" />}>Delete stream</AlertDialogTrigger>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {stream.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            Its deliveries and recorders go with it, and anything reading it stops. Its camera stays.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <FormError error={remove.error} />
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            loading={remove.isPending}
            onClick={() =>
              dialog.mutate(stream.id, {
                onSuccess: () => {
                  unpin();
                  navigate('..', { relative: 'path', replace: true });
                }
              })
            }
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
