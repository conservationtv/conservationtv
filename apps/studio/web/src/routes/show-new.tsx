import type { FC } from 'react';
import { useForm } from '@tanstack/react-form';
import { useNavigate } from 'react-router';
import { Button } from '@conservationtv/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@conservationtv/ui/components/dialog';
import { FieldGroup } from '@conservationtv/ui/components/field';

import type { Route } from './+types/show-new';
import { FormError } from '@/components/common/form-error';
import { NameSchema, type NameInput } from '@/forms/schemas';
import { TextField } from '@/forms/text-field';
import { useDialog } from '@/hooks/use-dialog';
import { useOrganisationId } from '@/hooks/use-organisation';
import { useCreateShow } from '@/queries/shows';

export const meta: Route.MetaFunction = () => [{ title: 'New show · conservation.tv studio' }];

/**
 * Making a show by name, its programme at the default encoding, as a dialog over the shows page at `shows/new`. Once
 * it is made, its page opens in the dialog's place.
 */
const ShowNewRoute: FC = () => {
  const organisationId = useOrganisationId();
  const navigate = useNavigate();
  const create = useCreateShow(organisationId);
  const defaultValues: NameInput = { name: '' };
  const form = useForm({
    defaultValues,
    validators: { onSubmit: NameSchema },
    onSubmit: ({ value }) =>
      dialog.mutate(NameSchema.parse(value), {
        onSuccess: show => navigate(`../${show.id}`, { relative: 'path', replace: true })
      })
  });
  const dialog = useDialog(create, { closeTo: '..' });
  return (
    <Dialog {...dialog.props}>
      <DialogContent>
        <form
          onSubmit={event => {
            event.preventDefault();
            form.handleSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle>New show</DialogTitle>
            <DialogDescription>
              It follows the organisation’s broadcast, at 1080p and 30 frames a second until you change it. Choose the
              agent that sends it out, and the channels it goes to, on its page.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-4">
            <form.Field name="name">
              {field => <TextField field={field} label="Name" placeholder="Waterhole, evenings" autoComplete="off" />}
            </form.Field>
            <FormError error={create.error} />
          </FieldGroup>
          <DialogFooter>
            <Button type="submit" loading={create.isPending}>
              Create show
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

export default ShowNewRoute;
