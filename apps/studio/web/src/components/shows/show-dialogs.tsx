import type { FC } from 'react';
import { useForm } from '@tanstack/react-form';
import { useNavigate } from 'react-router';

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

import { FormError } from '@/components/common/form-error';
import { NameSchema, type NameInput } from '@/forms/schemas';
import { TextField } from '@/forms/text-field';
import { useDialog } from '@/hooks/use-dialog';
import { useOrganisationId } from '@/hooks/use-organisation';
import { useUnpinPage } from '@/hooks/use-unpin-page';
import { useDeleteShow, useUpdateShow, type ListedShow } from '@/queries/shows';

// What an administrator changes about a show itself (making one is its own route, show-new): its name, and whether it
// exists. What it places is its composition's; how it goes out is each output's that follows it.

export interface ShowDialogProps {
  show: ListedShow;
}

/** Renames the show; the form starts from its stored name each time the dialog opens. */
export const RenameShowDialog: FC<ShowDialogProps> = ({ show }) => {
  const organisationId = useOrganisationId();
  const update = useUpdateShow(organisationId);
  const defaultValues: NameInput = { name: show.name };
  const form = useForm({
    defaultValues,
    validators: { onSubmit: NameSchema },
    onSubmit: ({ value }) => dialog.mutate({ showId: show.id, ...NameSchema.parse(value) })
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
            <DialogTitle>Rename {show.name}</DialogTitle>
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

/** Deletes the show, once confirmed, then goes back to the list. The outputs following it follow nothing. */
export const DeleteShowDialog: FC<ShowDialogProps> = ({ show }) => {
  const organisationId = useOrganisationId();
  const navigate = useNavigate();
  const remove = useDeleteShow(organisationId);
  const dialog = useDialog(remove);
  const unpin = useUnpinPage();
  return (
    <AlertDialog {...dialog.props}>
      <AlertDialogTrigger render={<Button variant="destructive" />}>Delete show</AlertDialogTrigger>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {show.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            Its composition goes with it. The outputs following it keep going out to their channels, with no scenes of
            the show, until each is given another.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <FormError error={remove.error} />
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            loading={remove.isPending}
            onClick={() =>
              dialog.mutate(show.id, {
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
