import type { FC } from 'react';
import { useForm } from '@tanstack/react-form';
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

import type { Route } from './+types/network-new';
import { FormError } from '@/components/common/form-error';
import { NameSchema, type NameInput } from '@/forms/schemas';
import { TextField } from '@/forms/text-field';
import { useDialog } from '@/hooks/use-dialog';
import { useOrganisationId } from '@/hooks/use-organisation';
import { useCreateNetwork } from '@/queries/networks';

export const meta: Route.MetaFunction = () => [{ title: 'Add a network · conservation.tv studio' }];

/**
 * Adding a network, as a dialog over the networks page at `networks/new`: by name, closing back to the list once it is
 * made.
 */
const NetworkNewRoute: FC = () => {
  const organisationId = useOrganisationId();
  const create = useCreateNetwork(organisationId);
  const defaultValues: NameInput = { name: '' };
  const form = useForm({
    defaultValues,
    validators: { onSubmit: NameSchema },
    onSubmit: ({ value }) => dialog.mutate(NameSchema.parse(value))
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
            <DialogTitle>Add a network</DialogTitle>
            <DialogDescription>
              A site with its own local network: a sanctuary, a reserve, a single building.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-4">
            <form.Field name="name">
              {field => <TextField field={field} label="Name" placeholder="Hide LAN" autoComplete="off" />}
            </form.Field>
            <FormError error={create.error} />
          </FieldGroup>
          <DialogFooter>
            <Button type="submit" loading={create.isPending}>
              Add network
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

export default NetworkNewRoute;
