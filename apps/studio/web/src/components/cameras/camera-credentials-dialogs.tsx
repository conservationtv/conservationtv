import { useState, type FC } from 'react';
import { useForm } from '@tanstack/react-form';
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

import { FormError } from '@/components/common/form-error';
import { CameraCredentialsSchema, type CameraCredentialsInput } from '@/forms/schemas';
import { TextField } from '@/forms/text-field';
import { useConfirm } from '@/hooks/use-confirm';
import { useOrganisationId } from '@/hooks/use-organisation';
import { useUpdateCamera } from '@/queries/cameras';

// A camera's credentials are write-only: kept encrypted, used only to pull from it, and never read back. So they are
// replaced or cleared, never shown or edited.

export interface CameraCredentialsDialogProps {
  cameraId: string;
  /** What the camera is called, for the dialog's title. */
  name: string;
}

/** Replaces the camera's username and password with new ones. The form starts empty each time it opens. */
export const ReplaceCredentialsDialog: FC<CameraCredentialsDialogProps> = ({ cameraId, name }) => {
  const organisationId = useOrganisationId();
  const [open, setOpen] = useState(false);
  const update = useUpdateCamera(organisationId);
  const defaultValues: CameraCredentialsInput = { username: '', password: '' };
  const form = useForm({
    defaultValues,
    validators: { onSubmit: CameraCredentialsSchema },
    onSubmit: ({ value }) =>
      update.mutate(
        { cameraId, credentials: CameraCredentialsSchema.parse(value) },
        { onSuccess: () => setOpen(false) }
      )
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
      <DialogTrigger render={<Button variant="ghost" size="sm" />}>Replace</DialogTrigger>
      <DialogContent>
        <form
          onSubmit={event => {
            event.preventDefault();
            form.handleSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle className="truncate">Credentials for {name}</DialogTitle>
            <DialogDescription>
              These replace whatever it has now. They’re kept encrypted and aren’t shown again.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-4">
            <form.Field name="username">
              {field => <TextField field={field} label="Username" autoComplete="off" spellCheck={false} />}
            </form.Field>
            <form.Field name="password">
              {field => <TextField field={field} label="Password" type="password" autoComplete="new-password" />}
            </form.Field>
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

/** Clears the camera's credentials once confirmed, for a camera that doesn't ask for any. */
export const ClearCredentialsDialog: FC<CameraCredentialsDialogProps> = ({ cameraId, name }) => {
  const organisationId = useOrganisationId();
  const update = useUpdateCamera(organisationId);
  const confirmation = useConfirm(update);
  return (
    <AlertDialog {...confirmation.dialog}>
      <AlertDialogTrigger render={<Button variant="ghost" size="sm" />}>Clear</AlertDialogTrigger>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle className="truncate">Clear {name}’s credentials?</AlertDialogTitle>
          <AlertDialogDescription>
            Its agent will connect without a username or password. If the camera asks for them, its streams stop.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <FormError error={update.error} />
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            loading={update.isPending}
            onClick={() => confirmation.confirm({ cameraId, credentials: null })}
          >
            Clear
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
