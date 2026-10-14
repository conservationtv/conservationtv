import type { FC } from 'react';
import { useForm } from '@tanstack/react-form';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import type { Account } from '@conservationtv/studio-sdk';
import { Button } from '@conservationtv/ui/components/button';
import { FieldGroup, FieldLegend, FieldSet } from '@conservationtv/ui/components/field';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@conservationtv/ui/components/empty';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle
} from '@conservationtv/ui/components/item';
import { Separator } from '@conservationtv/ui/components/separator';
import { Spinner } from '@conservationtv/ui/components/spinner';

import { FormError } from '@/components/common/form-error';
import type { Route } from './+types/account';
import { Panel } from '@/components/common/panel';
import { queryClient } from '@/lib/query-client';
import { requireSession } from '@/lib/route-guards';
import { AccountNameSchema, PasskeyNameSchema, type AccountNameInput, type PasskeyNameInput } from '@/forms/schemas';
import { TextField } from '@/forms/text-field';
import { accountQueries, useUpdateAccount } from '@/queries/account';
import { passkeyQueries, useAddPasskey, useDeletePasskey, type ListedPasskey } from '@/queries/passkeys';
import { useSignOut } from '@/queries/session';

export const meta: Route.MetaFunction = () => [{ title: 'Your account · conservation.tv studio' }];

/** Signed-in only. The account loads before the page renders; the passkey list starts loading alongside. */
export async function clientLoader({ request }: Route.ClientLoaderArgs) {
  await requireSession(request);
  // Start the passkey list without waiting on it; a failure shows on the page, not here.
  queryClient.query(passkeyQueries.list()).catch(() => {});
  await queryClient.query({ ...accountQueries.current(), staleTime: 'static' });
  return null;
}

/** The signed-in account, read and edited through the studio API, and its passkeys, managed through Better Auth. */
const AccountRoute: FC = () => {
  const navigate = useNavigate();
  const account = useQuery(accountQueries.current());
  const signOut = useSignOut();
  return (
    <Panel title="Your account">
      {account.data ? (
        // Keyed so the form starts from the stored name again after a save elsewhere.
        <ProfileForm key={account.data.name} account={account.data} />
      ) : (
        <FormError error={account.error} />
      )}
      <Separator />
      {account.data && <Passkeys email={account.data.email} />}
      <Separator />
      <Button
        variant="outline"
        loading={signOut.isPending}
        onClick={() => signOut.mutate(undefined, { onSuccess: () => navigate('/sign-in', { replace: true }) })}
      >
        Sign out
      </Button>
    </Panel>
  );
};

export default AccountRoute;

interface ProfileFormProps {
  account: Account;
}

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
      onSubmit={event => {
        event.preventDefault();
        form.handleSubmit();
      }}
    >
      <FieldGroup>
        <form.Field name="name">
          {field => <TextField field={field} label="Name" description={account.email} autoComplete="name" />}
        </form.Field>
        <FormError error={update.error} />
        <form.Subscribe selector={state => [state.isDirty, state.canSubmit] as const}>
          {([dirty, canSubmit]) => (
            <Button type="submit" loading={update.isPending} disabled={!dirty || !canSubmit}>
              Save
            </Button>
          )}
        </form.Subscribe>
      </FieldGroup>
    </form>
  );
};

interface PasskeysProps {
  email: string;
}

/** Register this device as a passkey for signing in later, and remove passkeys that are no longer wanted. */
const Passkeys: FC<PasskeysProps> = ({ email }) => {
  const passkeys = useQuery(passkeyQueries.list());
  const remove = useDeletePasskey();
  return (
    <FieldSet>
      <FieldLegend>Passkeys</FieldLegend>
      {passkeys.isPending ? (
        <Spinner className="text-muted-foreground" />
      ) : passkeys.data?.length ? (
        <ItemGroup>
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
      <FormError error={passkeys.error} />
      <FormError error={remove.error} />
      <AddPasskeyForm email={email} />
    </FieldSet>
  );
};

interface AddPasskeyFormProps {
  email: string;
}

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
        <Button type="submit" variant="outline" loading={add.isPending}>
          Add passkey
        </Button>
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
