import type { FC } from 'react';
import { useForm } from '@tanstack/react-form';
import { useNavigate } from 'react-router';
import { EnvelopeSimpleIcon } from '@phosphor-icons/react';
import type { GetInvitationsResponse } from '@conservationtv/studio-sdk';
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
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemMedia,
  ItemTitle
} from '@conservationtv/ui/components/item';
import { FieldGroup } from '@conservationtv/ui/components/field';

import { FormError } from '@/components/common/form-error';
import { DisplayNameSchema, type DisplayNameInput } from '@/forms/schemas';
import { TextField } from '@/forms/text-field';
import { useDialog } from '@/hooks/use-dialog';
import { formatRelative } from '@/lib/format';
import { useAcceptInvitation, useDeclineInvitation } from '@/queries/invitations';

/** An open invitation to the signed-in account, as its own list carries it. */
export type OwnInvitation = GetInvitationsResponse['invitations'][number];

export interface OwnInvitationItemProps {
  invitation: OwnInvitation;
  /** The account's own name, which the name it will go by in the organisation starts from. */
  accountName: string;
}

/**
 * An invitation waiting for the signed-in account: the organisation, when it expires, and accepting or declining it.
 * These are invitations to the account itself, so neither needs a code.
 */
export const OwnInvitationItem: FC<OwnInvitationItemProps> = ({ invitation, accountName }) => {
  const decline = useDeclineInvitation();
  return (
    <Item variant="outline">
      <ItemMedia variant="icon">
        <EnvelopeSimpleIcon />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{invitation.organisation.name}</ItemTitle>
        <ItemDescription>Expires {formatRelative(invitation.expiresAt)}</ItemDescription>
      </ItemContent>
      <ItemActions>
        <Button
          variant="ghost"
          size="sm"
          loading={decline.isPending}
          onClick={() => decline.mutate({ id: invitation.id })}
        >
          Decline
        </Button>
        <AcceptInvitationDialog invitation={invitation} accountName={accountName} />
      </ItemActions>
      {decline.error && (
        <ItemFooter>
          <FormError error={decline.error} />
        </ItemFooter>
      )}
    </Item>
  );
};

/** Accepts the invitation under a name for the organisation, then opens the organisation. */
const AcceptInvitationDialog: FC<OwnInvitationItemProps> = ({ invitation, accountName }) => {
  const navigate = useNavigate();
  const accept = useAcceptInvitation();
  const defaultValues: DisplayNameInput = { displayName: accountName };
  const form = useForm({
    defaultValues,
    validators: { onSubmit: DisplayNameSchema },
    onSubmit: ({ value }) =>
      dialog.mutate(
        { id: invitation.id, ...DisplayNameSchema.parse(value) },
        { onSuccess: membership => navigate(`/organisations/${membership.organisationId}`) }
      )
  });
  const dialog = useDialog(accept, { onOpen: () => form.reset() });
  return (
    <Dialog {...dialog.props}>
      <DialogTrigger render={<Button size="sm" />}>Accept</DialogTrigger>
      <DialogContent>
        <form
          onSubmit={event => {
            event.preventDefault();
            form.handleSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Join {invitation.organisation.name}</DialogTitle>
            <DialogDescription>Choose the name its members will see you as. You can change it later.</DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-4">
            <form.Field name="displayName">
              {field => <TextField field={field} label="Your name there" autoComplete="name" />}
            </form.Field>
            <FormError error={accept.error} />
          </FieldGroup>
          <DialogFooter>
            <Button type="submit" loading={accept.isPending}>
              Join
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
