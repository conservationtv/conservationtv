import { Suspense, useState, type FC } from 'react';
import { useForm } from '@tanstack/react-form';
import { useSuspenseQueries, useSuspenseQuery } from '@tanstack/react-query';
import { EnvelopeSimpleIcon, PlusIcon } from '@phosphor-icons/react';
import type { GetOrganisationsByIdInvitationsResponse } from '@conservationtv/studio-sdk';
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
import { Badge } from '@conservationtv/ui/components/badge';
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
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@conservationtv/ui/components/empty';
import { FieldGroup } from '@conservationtv/ui/components/field';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemGroup,
  ItemTitle
} from '@conservationtv/ui/components/item';
import { Skeleton } from '@conservationtv/ui/components/skeleton';

import { FormError } from '@/components/common/form-error';
import { Section, SectionDescription, SectionHeader, SectionHeading, SectionTitle } from '@/components/common/page';
import { badgeRoles, isAdministrator, memberName, type ListedMember } from '@/components/settings/roles';
import { InvitationEmailSchema, type InvitationEmailInput } from '@/forms/schemas';
import { TextField } from '@/forms/text-field';
import { useConfirm } from '@/hooks/use-confirm';
import { useIsAdministrator, useOrganisationId } from '@/hooks/use-organisation';
import { formatDate, formatRelative } from '@/lib/format';
import { accountQueryOptions } from '@/queries/account';
import {
  memberListQueryOptions,
  organisationInvitationListQueryOptions,
  useCancelInvitation,
  useCreateInvitation,
  useGrantAdmin,
  useRemoveMember,
  useRevokeAdmin
} from '@/queries/members';

/** One of the organisation's invitations, open or expired. */
type OrganisationInvitation = GetOrganisationsByIdInvitationsResponse['invitations'][number];

/**
 * The organisation's members: the name each goes by here, their roles, and when they joined. Administrators make and
 * unmake administrators and remove members, and below the directory they see and send invitations; the invitation
 * list is theirs alone, so it loads only for them.
 */
const SettingsMembersRoute: FC = () => {
  const organisationId = useOrganisationId();
  const administrator = useIsAdministrator();
  const [membersQuery, accountQuery] = useSuspenseQueries({
    queries: [memberListQueryOptions(organisationId), accountQueryOptions()]
  });
  const members = membersQuery.data;
  return (
    <>
      <Section>
        <SectionHeader>
          <SectionHeading>
            <SectionTitle>Members</SectionTitle>
            <SectionDescription>
              Everyone in the organisation, by the name they go by here. Their email addresses stay private.
            </SectionDescription>
          </SectionHeading>
        </SectionHeader>
        <ItemGroup className="gap-2">
          {members.map(member => (
            <MemberRow key={member.userId} member={member} own={member.userId === accountQuery.data.id} />
          ))}
        </ItemGroup>
      </Section>
      {administrator && (
        <Suspense fallback={<Skeleton className="h-24 w-full" />}>
          <InvitationsSection members={members} />
        </Suspense>
      )}
    </>
  );
};

export default SettingsMembersRoute;

interface MemberRowProps {
  member: ListedMember;
  /** Whether this is the signed-in account. */
  own: boolean;
}

/** A member: their name, their roles and when they joined, and for administrators, what may be changed about them. */
const MemberRow: FC<MemberRowProps> = ({ member, own }) => {
  const administrator = useIsAdministrator();
  return (
    <Item variant="outline">
      <ItemContent>
        <ItemTitle>
          {memberName(member)}
          {own && <Badge variant="secondary">You</Badge>}
          {badgeRoles(member).map(role => (
            <Badge key={role.id} variant="outline">
              {role.label}
            </Badge>
          ))}
        </ItemTitle>
        <ItemDescription>Joined {formatDate(member.joinedAt)}</ItemDescription>
      </ItemContent>
      {administrator && <MemberActions member={member} own={own} />}
    </Item>
  );
};

/**
 * Making the member an administrator or no longer one, and removing them. The signed-in account leaves from the
 * General tab instead. The API refuses to lose the last administrator, and its reason shows under the row.
 */
const MemberActions: FC<MemberRowProps> = ({ member, own }) => {
  const organisationId = useOrganisationId();
  const grant = useGrantAdmin(organisationId);
  const revoke = useRevokeAdmin(organisationId);
  const administers = isAdministrator(member);
  const error = grant.error ?? revoke.error;
  return (
    <>
      <ItemActions>
        {administers ? (
          <Button
            variant="ghost"
            size="sm"
            loading={revoke.isPending}
            onClick={() => {
              grant.reset();
              revoke.mutate(member.userId);
            }}
          >
            Remove administrator
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            loading={grant.isPending}
            onClick={() => {
              revoke.reset();
              grant.mutate(member.userId);
            }}
          >
            Make administrator
          </Button>
        )}
        {!own && <RemoveMemberDialog member={member} />}
      </ItemActions>
      {error && (
        <ItemFooter>
          <FormError error={error} />
        </ItemFooter>
      )}
    </>
  );
};

interface MemberDialogProps {
  member: ListedMember;
}

/** Removes the member once confirmed. */
const RemoveMemberDialog: FC<MemberDialogProps> = ({ member }) => {
  const organisationId = useOrganisationId();
  const remove = useRemoveMember(organisationId);
  const confirmation = useConfirm(remove);
  const name = memberName(member);
  return (
    <AlertDialog {...confirmation.dialog}>
      <AlertDialogTrigger render={<Button variant="ghost" size="sm" />}>Remove</AlertDialogTrigger>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>Remove {name}?</AlertDialogTitle>
          <AlertDialogDescription>
            They lose access to the organisation straight away. To come back, they’ll need a new invitation.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <FormError error={remove.error} />
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            loading={remove.isPending}
            onClick={() => confirmation.confirm(member.userId)}
          >
            Remove
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};

interface InvitationsSectionProps {
  /** The members, to name who sent each invitation. */
  members: ListedMember[];
}

/** The organisation's invitations, open and expired, and inviting someone new. Administrators only. */
const InvitationsSection: FC<InvitationsSectionProps> = ({ members }) => {
  const organisationId = useOrganisationId();
  const invitationsQuery = useSuspenseQuery(organisationInvitationListQueryOptions(organisationId));
  const invitations = invitationsQuery.data;
  return (
    <Section>
      <SectionHeader>
        {/* Grows from nothing, so the button beside it stays on the heading’s line however long the description. */}
        <SectionHeading className="flex-1 basis-0">
          <SectionTitle>Invitations</SectionTitle>
          <SectionDescription>
            Each is a link to join, open for 14 days, which whoever signs in with it can accept. The studio doesn’t send
            email yet: links are written to the API server’s log, for whoever runs it to pass on.
          </SectionDescription>
        </SectionHeading>
        <InviteDialog />
      </SectionHeader>
      {invitations.length > 0 ? (
        <ItemGroup className="gap-2">
          {invitations.map(invitation => (
            <InvitationRow
              key={invitation.id}
              invitation={invitation}
              sender={members.find(member => member.userId === invitation.invitedBy)}
            />
          ))}
        </ItemGroup>
      ) : (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <EnvelopeSimpleIcon />
            </EmptyMedia>
            <EmptyTitle>No open invitations</EmptyTitle>
            <EmptyDescription>Invite someone by their email address to add them to the organisation.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </Section>
  );
};

interface InvitationRowProps {
  invitation: OrganisationInvitation;
  /** The member who sent it, while they are still one. */
  sender: ListedMember | undefined;
}

/** An invitation: who it is to, who sent it and when, when it expires or did, and withdrawing it. */
const InvitationRow: FC<InvitationRowProps> = ({ invitation, sender }) => {
  const organisationId = useOrganisationId();
  const cancel = useCancelInvitation(organisationId);
  // When the row was first shown: what it says about expiry holds still while it stays on screen.
  const [now] = useState(Date.now);
  const expired = Date.parse(invitation.expiresAt) <= now;
  return (
    <Item variant="outline">
      <ItemContent>
        <ItemTitle>
          {invitation.email ?? 'An existing account'}
          {expired && <Badge variant="outline">Expired</Badge>}
        </ItemTitle>
        <ItemDescription>
          Sent {formatDate(invitation.createdAt)}
          {sender && ` by ${memberName(sender)}`} · {expired ? 'Expired' : 'Expires'}{' '}
          {formatRelative(invitation.expiresAt, now)}
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        <Button variant="ghost" size="sm" loading={cancel.isPending} onClick={() => cancel.mutate(invitation.id)}>
          {expired ? 'Remove' : 'Cancel'}
        </Button>
      </ItemActions>
      {cancel.error && (
        <ItemFooter>
          <FormError error={cancel.error} />
        </ItemFooter>
      )}
    </Item>
  );
};

/**
 * Invites someone by email address; the dialog closes once the invitation is made. Email isn't wired in to the API
 * yet (apps/studio/api/src/organisations/delivery.ts): the link is written to its log, and the dialog says so.
 */
const InviteDialog: FC = () => {
  const organisationId = useOrganisationId();
  const [open, setOpen] = useState(false);
  const create = useCreateInvitation(organisationId);
  const defaultValues: InvitationEmailInput = { email: '' };
  const form = useForm({
    defaultValues,
    validators: { onSubmit: InvitationEmailSchema },
    onSubmit: ({ value, formApi }) =>
      create.mutate(InvitationEmailSchema.parse(value), {
        onSuccess: () => {
          formApi.reset();
          setOpen(false);
        }
      })
  });
  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        setOpen(next);
        if (!next) create.reset();
      }}
    >
      <DialogTrigger render={<Button />}>
        <PlusIcon />
        Invite
      </DialogTrigger>
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
