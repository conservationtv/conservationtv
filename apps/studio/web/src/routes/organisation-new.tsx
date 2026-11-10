import type { FC } from 'react';
import { useForm } from '@tanstack/react-form';
import { useSuspenseQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { Button } from '@conservationtv/ui/components/button';
import { Field, FieldGroup } from '@conservationtv/ui/components/field';

import type { Route } from './+types/organisation-new';
import { FormError } from '@/components/common/form-error';
import { Page, PageDescription, PageHeader, PageHeading, PageTitle } from '@/components/common/page';
import { NewOrganisationSchema, type NewOrganisationInput } from '@/forms/schemas';
import { TextField } from '@/forms/text-field';
import { accountQueryOptions } from '@/queries/account';
import { useCreateOrganisation } from '@/queries/organisations';

export const meta: Route.MetaFunction = () => [{ title: 'New organisation · conservation.tv studio' }];

/**
 * Starting an organisation: its name, and the name the signed-in account goes by there, which starts from the
 * account's own. The account becomes its first member and administrator, and the new organisation opens.
 */
const OrganisationNewRoute: FC = () => {
  const navigate = useNavigate();
  const accountQuery = useSuspenseQuery(accountQueryOptions());
  const create = useCreateOrganisation();
  const defaultValues: NewOrganisationInput = { name: '', displayName: accountQuery.data.name };
  const form = useForm({
    defaultValues,
    validators: { onSubmit: NewOrganisationSchema },
    onSubmit: ({ value }) =>
      create.mutate(NewOrganisationSchema.parse(value), {
        onSuccess: organisation => navigate(`/organisations/${organisation.id}`)
      })
  });
  return (
    <Page>
      <PageHeader>
        <PageHeading>
          <PageTitle>New organisation</PageTitle>
          <PageDescription>
            An organisation holds a group’s cameras, streams and people. You’ll be its administrator, and can invite
            others once it’s made.
          </PageDescription>
        </PageHeading>
      </PageHeader>
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
              <TextField field={field} label="Name" placeholder="Hillside Sanctuary" autoComplete="organization" />
            )}
          </form.Field>
          <form.Field name="displayName">
            {field => (
              <TextField
                field={field}
                label="Your name there"
                description="What its members will see you as. You can change it later."
                autoComplete="name"
              />
            )}
          </form.Field>
          <FormError error={create.error} />
          <Field orientation="horizontal">
            <Button type="submit" loading={create.isPending}>
              Create organisation
            </Button>
          </Field>
        </FieldGroup>
      </form>
    </Page>
  );
};

export default OrganisationNewRoute;
