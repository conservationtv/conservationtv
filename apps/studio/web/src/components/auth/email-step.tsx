import type { FC } from 'react';
import { useForm } from '@tanstack/react-form';
import { useSelector } from '@xstate/store-react';
import { Button } from '@conservationtv/ui/components/button';
import { FieldGroup, FieldSeparator } from '@conservationtv/ui/components/field';

import { FormError } from '@/components/common/form-error';
import { PanelContent } from '@/components/common/panel';
import { EmailSchema, type EmailInput } from '@/forms/schemas';
import { TextField } from '@/forms/text-field';
import { useSendSignInCode } from '@/queries/session';
import { useSignInStore } from '@/stores/sign-in';

/** The email form, starting from the store's address (filled in after a passkey for that account didn't work). */
export const EmailStep: FC = () => {
  const store = useSignInStore();
  const email = useSelector(store, snapshot => snapshot.context.email);
  return (
    <PanelContent>
      <EmailForm key={email} defaultEmail={email} onSent={sentTo => store.trigger.codeSent({ email: sentTo })} />
      <RequestAccess />
    </PanelContent>
  );
};

interface EmailFormProps {
  defaultEmail: string;
  onSent: (email: string) => void;
}

const EmailForm: FC<EmailFormProps> = ({ defaultEmail, onSent }) => {
  const send = useSendSignInCode();
  const defaultValues: EmailInput = { email: defaultEmail };
  const form = useForm({
    defaultValues,
    validators: { onSubmit: EmailSchema },
    onSubmit: ({ value }) => send.mutate(value, { onSuccess: () => onSent(value.email) })
  });
  return (
    <form
      onSubmit={event => {
        event.preventDefault();
        form.handleSubmit();
      }}
    >
      <FieldGroup>
        <form.Field name="email">
          {field => <TextField field={field} label="Email" type="email" autoComplete="email" />}
        </form.Field>
        <FormError error={send.error} />
        <Button type="submit" loading={send.isPending}>
          Continue
        </Button>
      </FieldGroup>
    </form>
  );
};

/**
 * For anyone without an account yet. A placeholder: there's no access-request flow to send them to, so the button
 * does nothing for now.
 */
const RequestAccess: FC = () => {
  return (
    <FieldGroup>
      {/* The label sits on the card, not the page, so it takes the card's colour to break the line cleanly. */}
      <FieldSeparator className="*:data-[slot=field-separator-content]:bg-card">New to conservation.tv?</FieldSeparator>
      <Button type="button" variant="outline">
        Request access
      </Button>
    </FieldGroup>
  );
};
