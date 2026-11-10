import { Suspense, type FC } from 'react';
import { useForm } from '@tanstack/react-form';
import { useSuspenseQueries, useSuspenseQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import { BuildingsIcon, CaretRightIcon, PlusIcon } from '@phosphor-icons/react';
import type { Account, GetOrganisationsResponse } from '@conservationtv/studio-sdk';
import { Badge } from '@conservationtv/ui/components/badge';
import { Button } from '@conservationtv/ui/components/button';
import { Field, FieldGroup } from '@conservationtv/ui/components/field';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@conservationtv/ui/components/empty';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle
} from '@conservationtv/ui/components/item';
import { Spinner } from '@conservationtv/ui/components/spinner';

import { FormError } from '@/components/common/form-error';
import type { Route } from './+types/account';
import { OwnInvitationItem, type OwnInvitation } from '@/components/account/own-invitation';
import {
  Fact,
  FactLabel,
  Facts,
  FactValue,
  Page,
  PageDescription,
  PageHeader,
  PageHeading,
  PageTitle,
  Section,
  SectionDescription,
  SectionHeader,
  SectionHeading,
  SectionTitle
} from '@/components/common/page';
import { AccountNameSchema, PasskeyNameSchema, type AccountNameInput, type PasskeyNameInput } from '@/forms/schemas';
import { TextField } from '@/forms/text-field';
import { accountQueryOptions, useUpdateAccount } from '@/queries/account';
import { ownInvitationListQueryOptions } from '@/queries/invitations';
import { organisationListQueryOptions } from '@/queries/organisations';
import { passkeyListQueryOptions, useAddPasskey, useDeletePasskey, type ListedPasskey } from '@/queries/passkeys';
import { useSignOut } from '@/queries/session';

export const meta: Route.MetaFunction = () => [{ title: 'Your account · conservation.tv studio' }];

/** An organisation the account is in, with the roles it holds there. */
type OwnOrganisation = GetOrganisationsResponse['organisations'][number];

/**
 * The signed-in account: its profile, read and edited through the studio API; its passkeys, managed through Better
 * Auth; the organisations it is in and the invitations waiting for it; and signing out. The passkeys load in their own
 * boundary, so the rest shows without waiting for them.
 */
const AccountRoute: FC = () => {
  const [accountQuery, organisationsQuery, invitationsQuery] = useSuspenseQueries({
    queries: [accountQueryOptions(), organisationListQueryOptions(), ownInvitationListQueryOptions()]
  });
  const account = accountQuery.data;
  return (
    <Page>
      <PageHeader>
        <PageHeading>
          <PageTitle>Your account</PageTitle>
          <PageDescription>How you sign in, the organisations you’re in, and those inviting you.</PageDescription>
        </PageHeading>
      </PageHeader>
      <Section>
        <SectionHeader>
          <SectionHeading>
            <SectionTitle>Profile</SectionTitle>
            <SectionDescription>
              The address you sign in with, and your name. Each organisation has its own name for you, set in its
              settings.
            </SectionDescription>
          </SectionHeading>
        </SectionHeader>
        {/* Keyed so the form starts from the stored name again after a save elsewhere. */}
        <ProfileForm key={account.name} account={account} />
      </Section>
      <Section>
        <SectionHeader>
          <SectionHeading>
            <SectionTitle>Passkeys</SectionTitle>
            <SectionDescription>Sign in with this device instead of an emailed code.</SectionDescription>
          </SectionHeading>
        </SectionHeader>
        <Suspense fallback={<Spinner className="text-muted-foreground" />}>
          <Passkeys email={account.email} />
        </Suspense>
      </Section>
      <OrganisationsSection organisations={organisationsQuery.data} />
      <InvitationsSection invitations={invitationsQuery.data} accountName={account.name} />
      <SignOutSection />
    </Page>
  );
};

export default AccountRoute;

interface ProfileFormProps {
  account: Account;
}

/** The account's name, saved once changed, beside the email address it signs in with, which can't be. */
const ProfileForm: FC<ProfileFormProps> = ({ account }) => {
  const update = useUpdateAccount();
  const defaultValues: AccountNameInput = { name: account.name };
  const form = useForm({
    defaultValues,
    validators: { onChange: AccountNameSchema },
    onSubmit: ({ value }) => update.mutate(AccountNameSchema.parse(value))
  });
  return (
    <form
      className="max-w-md"
      onSubmit={event => {
        event.preventDefault();
        form.handleSubmit();
      }}
    >
      <FieldGroup>
        <Facts>
          <Fact>
            <FactLabel>Email</FactLabel>
            <FactValue>{account.email}</FactValue>
          </Fact>
        </Facts>
        <form.Field name="name">{field => <TextField field={field} label="Name" autoComplete="name" />}</form.Field>
        <FormError error={update.error} />
        <Field orientation="horizontal">
          <form.Subscribe selector={state => [state.isDirty, state.canSubmit] as const}>
            {([dirty, canSubmit]) => (
              <Button type="submit" loading={update.isPending} disabled={!dirty || !canSubmit}>
                Save
              </Button>
            )}
          </form.Subscribe>
        </Field>
      </FieldGroup>
    </form>
  );
};

interface PasskeysProps {
  email: string;
}

/** Register this device as a passkey for signing in later, and remove passkeys that are no longer wanted. */
const Passkeys: FC<PasskeysProps> = ({ email }) => {
  const passkeys = useSuspenseQuery(passkeyListQueryOptions());
  const remove = useDeletePasskey();
  return (
    <div className="flex flex-col gap-4">
      {passkeys.data.length ? (
        <ItemGroup className="gap-2">
          {passkeys.data.map(passkey => (
            <PasskeyRow
              key={passkey.id}
              passkey={passkey}
              removing={remove.isPending ? remove.variables.id : undefined}
              onRemove={() => remove.mutate(passkey)}
            />
          ))}
        </ItemGroup>
      ) : (
        <Empty className="border">
          <EmptyHeader>
            <EmptyTitle>No passkeys yet</EmptyTitle>
            <EmptyDescription>Add one to sign in without an email code.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      <FormError error={remove.error} />
      <AddPasskeyForm email={email} />
    </div>
  );
};

interface AddPasskeyFormProps {
  email: string;
}

/** Registers this device as a passkey, under an optional name. */
const AddPasskeyForm: FC<AddPasskeyFormProps> = ({ email }) => {
  const add = useAddPasskey();
  const defaultValues: PasskeyNameInput = { name: '' };
  const form = useForm({
    defaultValues,
    validators: { onSubmit: PasskeyNameSchema },
    onSubmit: ({ value, formApi }) =>
      add.mutate({ ...PasskeyNameSchema.parse(value), email }, { onSuccess: () => formApi.reset() })
  });
  return (
    <form
      className="max-w-md"
      onSubmit={event => {
        event.preventDefault();
        form.handleSubmit();
      }}
    >
      <FieldGroup>
        <form.Field name="name">
          {field => (
            <TextField
              field={field}
              label="New passkey"
              description="Optional. Name it after this device."
              placeholder="Laptop"
            />
          )}
        </form.Field>
        <FormError error={add.error} />
        <Field orientation="horizontal">
          <Button type="submit" variant="outline" loading={add.isPending}>
            Add passkey
          </Button>
        </Field>
      </FieldGroup>
    </form>
  );
};

interface PasskeyRowProps {
  passkey: ListedPasskey;
  /** The passkey being removed, if any: that row's button spins; the others wait until it's done. */
  removing: string | undefined;
  onRemove: () => void;
}

/** A passkey: its name, whether it syncs, and removing it. */
const PasskeyRow: FC<PasskeyRowProps> = ({ passkey, removing, onRemove }) => {
  return (
    <Item variant="outline" size="sm">
      <ItemContent>
        <ItemTitle>{passkey.name || 'Unnamed passkey'}</ItemTitle>
        <ItemDescription>
          {passkey.deviceType === 'multiDevice' ? 'Synced across your devices' : 'This device only'}
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        <Button
          variant="ghost"
          size="sm"
          loading={removing === passkey.id}
          disabled={removing !== undefined}
          onClick={onRemove}
        >
          Remove
        </Button>
      </ItemActions>
    </Item>
  );
};

interface OrganisationsSectionProps {
  organisations: OwnOrganisation[];
}

/** The organisations the account is in, each opening it, with the roles the account holds there; and starting one. */
const OrganisationsSection: FC<OrganisationsSectionProps> = ({ organisations }) => {
  return (
    <Section>
      <SectionHeader>
        <SectionHeading className="flex-1 basis-0">
          <SectionTitle>Organisations</SectionTitle>
          <SectionDescription>The organisations you’re in, and what you are in each.</SectionDescription>
        </SectionHeading>
        <Button variant="outline" nativeButton={false} render={<Link to="/organisations/new" />}>
          <PlusIcon />
          New organisation
        </Button>
      </SectionHeader>
      {organisations.length > 0 ? (
        <ItemGroup className="gap-2">
          {organisations.map(organisation => (
            <Item key={organisation.id} variant="outline" render={<Link to={`/organisations/${organisation.id}`} />}>
              <ItemMedia variant="icon">
                <BuildingsIcon />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{organisation.name}</ItemTitle>
              </ItemContent>
              <ItemActions>
                {organisation.roles.map(role => (
                  <Badge key={role.id} variant="outline">
                    {role.label}
                  </Badge>
                ))}
                <CaretRightIcon className="size-3.5 text-muted-foreground" />
              </ItemActions>
            </Item>
          ))}
        </ItemGroup>
      ) : (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <BuildingsIcon />
            </EmptyMedia>
            <EmptyTitle>Not in an organisation yet</EmptyTitle>
            <EmptyDescription>Start one, or accept an invitation to one.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </Section>
  );
};

interface InvitationsSectionProps {
  invitations: OwnInvitation[];
  /** The account's own name, which the name it will go by in an organisation starts from. */
  accountName: string;
}

/** The invitations waiting for the account, to accept or decline. */
const InvitationsSection: FC<InvitationsSectionProps> = ({ invitations, accountName }) => {
  return (
    <Section>
      <SectionHeader>
        <SectionHeading>
          <SectionTitle>Invitations</SectionTitle>
          <SectionDescription>
            Invitations to your account. One sent to an email address opens from its link instead.
          </SectionDescription>
        </SectionHeading>
      </SectionHeader>
      {invitations.length > 0 ? (
        <ItemGroup className="gap-2">
          {invitations.map(invitation => (
            <OwnInvitationItem key={invitation.id} invitation={invitation} accountName={accountName} />
          ))}
        </ItemGroup>
      ) : (
        <p className="text-custom-13 text-custom-text-secondary">No invitations are waiting for you.</p>
      )}
    </Section>
  );
};

/** Signs out, then leaves for the sign-in page. */
const SignOutSection: FC = () => {
  const navigate = useNavigate();
  const signOut = useSignOut();
  return (
    <Section>
      <SectionHeader>
        <SectionHeading className="flex-1 basis-0">
          <SectionTitle>Sign out</SectionTitle>
          <SectionDescription>
            This browser still remembers your account afterwards, so signing in again takes one step.
          </SectionDescription>
        </SectionHeading>
        <Button
          variant="outline"
          loading={signOut.isPending}
          onClick={() => signOut.mutate(undefined, { onSuccess: () => navigate('/sign-in', { replace: true }) })}
        >
          Sign out
        </Button>
      </SectionHeader>
    </Section>
  );
};
