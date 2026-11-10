import type { FC } from 'react';
import { useForm } from '@tanstack/react-form';
import { useSuspenseQueries } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import type { Organisation } from '@conservationtv/studio-sdk';
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
import { Field, FieldGroup } from '@conservationtv/ui/components/field';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle
} from '@conservationtv/ui/components/item';

import { CopyButton } from '@/components/common/copy-button';
import { FormError } from '@/components/common/form-error';
import {
  Fact,
  FactLabel,
  Facts,
  FactValue,
  Section,
  SectionDescription,
  SectionHeader,
  SectionHeading,
  SectionTitle
} from '@/components/common/page';
import { DisplayNameSchema, NameSchema, type DisplayNameInput, type NameInput } from '@/forms/schemas';
import { TextField } from '@/forms/text-field';
import { useDialog } from '@/hooks/use-dialog';
import { useIsAdministrator, useOrganisationId } from '@/hooks/use-organisation';
import { formatDate } from '@/lib/format';
import { accountQueryOptions } from '@/queries/account';
import { memberListQueryOptions, useRemoveMember, useUpdateOwnMembership } from '@/queries/members';
import { organisationQueryOptions, useDeleteOrganisation, useRenameOrganisation } from '@/queries/organisations';

/**
 * The organisation's general settings: its name, the name the signed-in account goes by in it, the facts about it, and
 * leaving or deleting it. Everyone sees them; only administrators rename it or are offered deleting it.
 */
const SettingsGeneralRoute: FC = () => {
  const organisationId = useOrganisationId();
  const [organisationQuery, membersQuery, accountQuery] = useSuspenseQueries({
    queries: [organisationQueryOptions(organisationId), memberListQueryOptions(organisationId), accountQueryOptions()]
  });
  const organisation = organisationQuery.data;
  const own = membersQuery.data.find(member => member.userId === accountQuery.data.id);
  const displayName = own?.displayName ?? '';
  return (
    <>
      <OrganisationNameSection organisation={organisation} />
      <Section>
        <SectionHeader>
          <SectionHeading>
            <SectionTitle>Your name here</SectionTitle>
            <SectionDescription>
              What the organisation’s members see you as. Each organisation you’re in has its own.
            </SectionDescription>
          </SectionHeading>
        </SectionHeader>
        {/* Keyed so the form starts from the stored name again after a save. */}
        <DisplayNameForm key={displayName} displayName={displayName} />
      </Section>
      <Section>
        <SectionHeader>
          <SectionHeading>
            <SectionTitle>Details</SectionTitle>
          </SectionHeading>
        </SectionHeader>
        <Facts>
          <Fact className="col-span-2">
            <FactLabel>Organisation ID</FactLabel>
            <FactValue className="flex items-center gap-1">
              <span className="truncate font-mono text-custom-12">{organisation.id}</span>
              <CopyButton value={organisation.id} label="Copy organisation ID" />
            </FactValue>
          </Fact>
          <Fact>
            <FactLabel>Created</FactLabel>
            <FactValue>{formatDate(organisation.createdAt)}</FactValue>
          </Fact>
        </Facts>
      </Section>
      <LeaveOrDeleteSection organisation={organisation} />
    </>
  );
};

export default SettingsGeneralRoute;

interface OrganisationProps {
  organisation: Organisation;
}

/** The organisation's name: a form for administrators, the name itself for everyone else. */
const OrganisationNameSection: FC<OrganisationProps> = ({ organisation }) => {
  const administrator = useIsAdministrator();
  return (
    <Section>
      <SectionHeader>
        <SectionHeading>
          <SectionTitle>Name</SectionTitle>
          <SectionDescription>
            {administrator
              ? 'What everyone in the organisation sees it called.'
              : 'What everyone in the organisation sees it called. Administrators can change it.'}
          </SectionDescription>
        </SectionHeading>
      </SectionHeader>
      {administrator ? (
        // Keyed so the form starts from the stored name again after a save.
        <RenameOrganisationForm key={organisation.name} organisation={organisation} />
      ) : (
        <p className="text-custom-13 text-foreground">{organisation.name}</p>
      )}
    </Section>
  );
};

/** Renames the organisation. Save stays off until the name has changed. */
const RenameOrganisationForm: FC<OrganisationProps> = ({ organisation }) => {
  const rename = useRenameOrganisation(organisation.id);
  const defaultValues: NameInput = { name: organisation.name };
  const form = useForm({
    defaultValues,
    validators: { onChange: NameSchema },
    onSubmit: ({ value }) => rename.mutate(NameSchema.parse(value).name)
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
          {field => <TextField field={field} label="Organisation name" autoComplete="organization" />}
        </form.Field>
        <FormError error={rename.error} />
        <Field orientation="horizontal">
          <form.Subscribe selector={state => [state.isDirty, state.canSubmit] as const}>
            {([dirty, canSubmit]) => (
              <Button type="submit" loading={rename.isPending} disabled={!dirty || !canSubmit}>
                Save
              </Button>
            )}
          </form.Subscribe>
        </Field>
      </FieldGroup>
    </form>
  );
};

interface DisplayNameFormProps {
  /** The name the signed-in account goes by here now; empty if it has none. */
  displayName: string;
}

/** Changes the name the signed-in account goes by in this organisation. Save stays off until it has changed. */
const DisplayNameForm: FC<DisplayNameFormProps> = ({ displayName }) => {
  const organisationId = useOrganisationId();
  const update = useUpdateOwnMembership(organisationId);
  const defaultValues: DisplayNameInput = { displayName };
  const form = useForm({
    defaultValues,
    validators: { onChange: DisplayNameSchema },
    onSubmit: ({ value }) => update.mutate(DisplayNameSchema.parse(value))
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
        <form.Field name="displayName">
          {field => <TextField field={field} label="Display name" autoComplete="name" />}
        </form.Field>
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

/** Leaving the organisation, for everyone, and deleting it, offered to administrators. */
const LeaveOrDeleteSection: FC<OrganisationProps> = ({ organisation }) => {
  const administrator = useIsAdministrator();
  return (
    <Section>
      <SectionHeader>
        <SectionHeading>
          <SectionTitle>Leave or delete</SectionTitle>
        </SectionHeading>
      </SectionHeader>
      <ItemGroup className="gap-2">
        <Item variant="outline">
          <ItemContent>
            <ItemTitle>Leave {organisation.name}</ItemTitle>
            <ItemDescription>
              You lose access to everything in it until you’re invited again. Its last administrator can’t leave.
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <LeaveOrganisationDialog organisation={organisation} />
          </ItemActions>
        </Item>
        {administrator && (
          <Item variant="outline">
            <ItemContent>
              <ItemTitle>Delete {organisation.name}</ItemTitle>
              <ItemDescription>
                Removes its members, invitations and everyone’s access to it. Only the service’s global administrators
                may.
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <DeleteOrganisationDialog organisation={organisation} />
            </ItemActions>
          </Item>
        )}
      </ItemGroup>
    </Section>
  );
};

/** Leaves the organisation once confirmed, then goes home. The API refuses its last administrator, and says so here. */
const LeaveOrganisationDialog: FC<OrganisationProps> = ({ organisation }) => {
  const navigate = useNavigate();
  const remove = useRemoveMember(organisation.id);
  const dialog = useDialog(remove);
  return (
    <AlertDialog {...dialog.props}>
      <AlertDialogTrigger render={<Button variant="outline" />}>Leave</AlertDialogTrigger>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>Leave {organisation.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            You’ll no longer see its streams, devices or members. To come back, someone will need to invite you.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <FormError error={remove.error} />
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            loading={remove.isPending}
            onClick={() => dialog.mutate('me', { onSuccess: () => navigate('/organisations', { replace: true }) })}
          >
            Leave
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};

/**
 * Deletes the organisation once confirmed, then goes home. Only global administrators may, which nothing here can
 * tell, so it is offered to every administrator and the API's refusal shows in the dialog.
 */
const DeleteOrganisationDialog: FC<OrganisationProps> = ({ organisation }) => {
  const navigate = useNavigate();
  const remove = useDeleteOrganisation(organisation.id);
  const dialog = useDialog(remove);
  return (
    <AlertDialog {...dialog.props}>
      <AlertDialogTrigger render={<Button variant="outline" />}>Delete</AlertDialogTrigger>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {organisation.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            Everyone loses access to it, and its members and invitations are removed. Only the service’s global
            administrators may delete an organisation: for anyone else, this is refused.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <FormError error={remove.error} />
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            loading={remove.isPending}
            onClick={() => dialog.mutate(undefined, { onSuccess: () => navigate('/organisations', { replace: true }) })}
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
