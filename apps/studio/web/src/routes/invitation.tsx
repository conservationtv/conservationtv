import type { FC } from 'react';
import { useForm } from '@tanstack/react-form';
import { useSuspenseQueries } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { HttpError, type Account, type Invitation } from '@conservationtv/studio-sdk';
import { Button } from '@conservationtv/ui/components/button';
import { Field, FieldGroup } from '@conservationtv/ui/components/field';

import type { Route } from './+types/invitation';
import { FormError } from '@/components/common/form-error';
import { Panel, PanelBody, PanelCard, PanelColumn } from '@/components/common/panel';
import { Step, Steps } from '@/components/common/steps';
import { DisplayNameSchema, type DisplayNameInput } from '@/forms/schemas';
import { TextField } from '@/forms/text-field';
import { formatRelative } from '@/lib/format';
import { accountQueryOptions } from '@/queries/account';
import { invitationQueryOptions, useAcceptInvitation, useDeclineInvitation } from '@/queries/invitations';

export const meta: Route.MetaFunction = () => [{ title: 'Invitation · conservation.tv studio' }];

/**
 * What an emailed invitation's link opens (`/invitations/{id}?code=…`): one card, to join the organisation under a name
 * of your choosing or turn it down. Signed in only, so someone signed out signs in first and comes back. The API's
 * refusals, for an expired invitation, a wrong code or an account already in, each read as a state of their own.
 */
const InvitationRoute: FC<Route.ComponentProps> = ({ params }) => {
  const [searchParams] = useSearchParams();
  const code = searchParams.get('code') ?? undefined;
  const [invitationQuery, accountQuery] = useSuspenseQueries({
    queries: [invitationQueryOptions(params.invitationId), accountQueryOptions()]
  });
  const invitation = invitationQuery.data;
  return (
    <PanelColumn>
      <PanelCard>
        {invitation.needsCode && code === undefined ? (
          <PanelBody
            title="This link is missing its code"
            description="Open the link exactly as it was sent to you: it ends with a one-time code that lets you join."
          />
        ) : (
          <InvitationAnswer invitation={invitation} code={code} account={accountQuery.data} />
        )}
      </PanelCard>
    </PanelColumn>
  );
};

export default InvitationRoute;

/**
 * An invitation that isn't open reads as not found: it was accepted, declined, cancelled or has expired, and the API
 * doesn't say which. Anything else is the usual error card.
 */
export const ErrorBoundary: FC<Route.ErrorBoundaryProps> = ({ error }) => {
  if (error instanceof HttpError && error.status === 404) {
    return (
      <Panel
        title="This invitation isn’t open"
        description="It has been used, cancelled or has expired. Ask whoever invited you to send a new one."
      >
        <StudioLink />
      </Panel>
    );
  }
  return <Panel title="Something went wrong" description={error instanceof Error ? error.message : undefined} />;
};

/** What the card shows once the invitee has answered and the API has refused, or the invitation is declined. */
type Outcome = 'answer' | 'declined' | 'already-member' | 'expired' | 'invalid-code' | 'gone';

/** The API's refusals that are answers in themselves, by their error code; any other failure stays on the form. */
const REFUSALS = new Map<string, Outcome>([
  ['already_member', 'already-member'],
  ['invitation_expired', 'expired'],
  ['invalid_invitation_code', 'invalid-code'],
  ['not_found', 'gone']
]);

/** The outcome a failed answer leads to, if it is one of the refusals with a card of its own. */
function refusalOf(error: Error | null): Outcome | undefined {
  if (!(error instanceof HttpError) || error.code === undefined) return undefined;
  return REFUSALS.get(error.code);
}

interface InvitationAnswerProps {
  invitation: Invitation;
  /** The one-time code from the link, if it has one. */
  code: string | undefined;
  account: Account;
}

/** Accepting or declining, sliding on to the outcome when the API refuses or the invitation is declined. */
const InvitationAnswer: FC<InvitationAnswerProps> = ({ invitation, code, account }) => {
  const accept = useAcceptInvitation();
  const decline = useDeclineInvitation();
  const declined = decline.isSuccess ? 'declined' : undefined;
  const active: Outcome = declined ?? refusalOf(accept.error) ?? refusalOf(decline.error) ?? 'answer';
  const name = invitation.organisation.name;
  return (
    <Steps active={active}>
      <Step value="answer">
        <PanelBody
          title={`Join ${name}`}
          description={`You’ll join as ${account.email}. The invitation expires ${formatRelative(invitation.expiresAt)}.`}
        >
          <AnswerForm invitation={invitation} code={code} account={account} accept={accept} decline={decline} />
        </PanelBody>
      </Step>
      <Step value="declined">
        <PanelBody title="Invitation declined" description={`You won’t join ${name}. The link no longer works.`}>
          <StudioLink />
        </PanelBody>
      </Step>
      <Step value="already-member">
        <PanelBody title={`You’re already in ${name}`} description="This account is already one of its members.">
          <Field orientation="horizontal">
            <Button nativeButton={false} render={<Link to={`/organisations/${invitation.organisation.id}`} />}>
              Open {name}
            </Button>
          </Field>
        </PanelBody>
      </Step>
      <Step value="expired">
        <PanelBody
          title="This invitation has expired"
          description={`Ask someone who runs ${name} to invite you again.`}
        >
          <StudioLink />
        </PanelBody>
      </Step>
      <Step value="invalid-code">
        <PanelBody
          title="This link’s code isn’t right"
          description="Open the link exactly as it was sent to you. If it still doesn’t work, ask for a new invitation."
        />
      </Step>
      <Step value="gone">
        <PanelBody
          title="This invitation isn’t open"
          description="It has been used, cancelled or has expired. Ask whoever invited you to send a new one."
        >
          <StudioLink />
        </PanelBody>
      </Step>
    </Steps>
  );
};

interface AnswerFormProps extends InvitationAnswerProps {
  accept: ReturnType<typeof useAcceptInvitation>;
  decline: ReturnType<typeof useDeclineInvitation>;
}

/**
 * The name to go by in the organisation, starting from the account's own, with Accept and Decline. Accepting opens the
 * organisation; declining needs no name.
 */
const AnswerForm: FC<AnswerFormProps> = ({ invitation, code, account, accept, decline }) => {
  const navigate = useNavigate();
  const defaultValues: DisplayNameInput = { displayName: account.name };
  const form = useForm({
    defaultValues,
    validators: { onSubmit: DisplayNameSchema },
    onSubmit: ({ value }) => {
      decline.reset();
      accept.mutate(
        { id: invitation.id, code, ...DisplayNameSchema.parse(value) },
        { onSuccess: membership => navigate(`/organisations/${membership.organisationId}`, { replace: true }) }
      );
    }
  });
  const pending = accept.isPending || decline.isPending;
  return (
    <form
      onSubmit={event => {
        event.preventDefault();
        form.handleSubmit();
      }}
    >
      <FieldGroup>
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
        <FormError error={accept.error ?? decline.error} />
        <Field orientation="horizontal">
          <Button type="submit" loading={accept.isPending} disabled={pending}>
            Accept
          </Button>
          <Button
            type="button"
            variant="outline"
            loading={decline.isPending}
            disabled={pending}
            onClick={() => {
              accept.reset();
              decline.mutate({ id: invitation.id, code });
            }}
          >
            Decline
          </Button>
        </Field>
      </FieldGroup>
    </form>
  );
};

/** On to the studio's home, for when there is nothing more to do here. */
const StudioLink: FC = () => {
  return (
    <Field orientation="horizontal">
      <Button variant="outline" nativeButton={false} render={<Link to="/organisations" />}>
        Go to the studio
      </Button>
    </Field>
  );
};
