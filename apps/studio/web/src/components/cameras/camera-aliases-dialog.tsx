import type { FC } from 'react';
import { useForm } from '@tanstack/react-form';
import type { Camera } from '@conservationtv/studio-sdk';
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
import { FieldDescription, FieldGroup } from '@conservationtv/ui/components/field';

import { cameraChatNamesOf } from '@/components/cameras/cameras';
import { FormError } from '@/components/common/form-error';
import { CameraAliasesSchema, type CameraAliasesInput } from '@/forms/schemas';
import { TextField } from '@/forms/text-field';
import { useDialog } from '@/hooks/use-dialog';
import { useOrganisationId } from '@/hooks/use-organisation';
import { conflictAs } from '@/lib/conflict';
import { useUpdateCamera } from '@/queries/cameras';

export interface CameraAliasesDialogProps {
  camera: Camera;
  /** What the camera is called: chat matches it too. */
  name: string;
}

/** The aliases typed so far, as they would be kept: the same split the form's schema makes, without its checks. */
function typedAliases(list: string): string[] {
  return list
    .split(/[,\n]+/u)
    .map(alias => alias.trim())
    .filter(alias => alias !== '');
}

/**
 * Changes what else a camera is called in chat: its aliases, typed as one list and replaced whole, so removing one
 * from the list removes it. Beneath the list, the names chat will match as they are typed, since chat compares names
 * without case, spaces or punctuation. The API refuses a name another camera already answers to.
 */
export const CameraAliasesDialog: FC<CameraAliasesDialogProps> = ({ camera, name }) => {
  const organisationId = useOrganisationId();
  const update = useUpdateCamera(organisationId);
  const defaultValues: CameraAliasesInput = { aliases: camera.aliases.join(', ') };
  const form = useForm({
    defaultValues,
    validators: { onSubmit: CameraAliasesSchema },
    onSubmit: ({ value }) => dialog.mutate({ cameraId: camera.id, aliases: CameraAliasesSchema.parse(value).aliases })
  });
  const dialog = useDialog(update, { onOpen: () => form.reset() });
  return (
    <Dialog {...dialog.props}>
      <DialogTrigger render={<Button variant="ghost" size="sm" />}>Edit</DialogTrigger>
      <DialogContent>
        <form
          onSubmit={event => {
            event.preventDefault();
            form.handleSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle className="truncate">What {name} is called in chat</DialogTitle>
            <DialogDescription>
              Chat commands that take a camera find it by its name, or by any of these. Chat ignores case, spaces and
              punctuation, and takes a name as one word.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-4">
            <form.Field name="aliases">
              {field => (
                <TextField
                  field={field}
                  label="Also called"
                  placeholder="pond, hide cam"
                  description="Separated by commas. Leave it empty for its name alone."
                  autoComplete="off"
                  spellCheck={false}
                />
              )}
            </form.Field>
            <form.Subscribe selector={state => state.values.aliases}>
              {aliases => (
                <FieldDescription>
                  In chat it answers to: {cameraChatNamesOf(name, typedAliases(aliases)).join(', ') || 'nothing yet'}
                </FieldDescription>
              )}
            </form.Subscribe>
            <FormError error={conflictAs(update.error, 'Another camera is already called that.')} />
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
