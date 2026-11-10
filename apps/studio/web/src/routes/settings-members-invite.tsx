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

import type { Route } from './+types/settings-members-invite';
import { FormError } from '@/components/common/form-error';
import { InvitationEmailSchema, type InvitationEmailInput } from '@/forms/schemas';
import { TextField } from '@/forms/text-field';
import { useDialog } from '@/hooks/use-dialog';
import { useOrganisationId } from '@/hooks/use-organisation';
import { useCreateInvitation } from '@/queries/members';

export const meta: Route.MetaFunction = () => [{ title: 'Invite someone · conservation.tv studio' }];

/**
 * Inviting someone by email address, as a dialog over the members page at `settings/members/invite`, closing back to
 * it once the invitation is made. Email isn't wired in to the API
 * yet (apps/studio/api/src/organisations/delivery.ts): the link is written to its log, and the dialog says so.
 */
const SettingsMembersInviteRoute: FC = () => {
  const organisationId = useOrganisationId();
  const create = useCreateInvitation(organisationId);
  const defaultValues: InvitationEmailInput = { email: '' };
  const form = useForm({
    defaultValues,
    validators: { onSubmit: InvitationEmailSchema },
    onSubmit: ({ value }) => dialog.mutate(InvitationEmailSchema.parse(value))
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
            <DialogTitle>Invite someone</DialogTitle>
            <DialogDescription>
              They’re sent a link to join, open for 14 days. Until the studio sends email, the link is written to the
              API server’s log instead.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-4">
            <form.Field name="email">
              {field => (
                <TextField
                  field={field}
                  label="Email"
                  type="email"
                  placeholder="ranger@example.org"
                  autoComplete="off"
                />
              )}
            </form.Field>
            <FormError error={create.error} />
          </FieldGroup>
          <DialogFooter>
            <Button type="submit" loading={create.isPending}>
              Send invitation
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

export default SettingsMembersInviteRoute;
