import type { FC } from 'react';
import { useForm } from '@tanstack/react-form';
import { useSelector } from '@xstate/store-react';
import { Button } from '@conservationtv/ui/components/button';
import { FieldGroup } from '@conservationtv/ui/components/field';
import { REGEXP_ONLY_DIGITS } from 'input-otp';

import { FormError } from '@/components/form-error';
import { PanelContent } from '@/components/panel';
import { CodeSchema, type CodeInput } from '@/forms/schemas';
import { OtpField } from '@/forms/otp-field';
import { useSessionChanged, useSignInWithCode } from '@/queries/session';
import { useSignInStore } from '@/stores/sign-in';

/**
 * The emailed code. Signing in also decides whether to offer a passkey: if so the store moves to that offer,
 * otherwise the session is refreshed and the page moves on.
 */
export const CodeStep: FC = () => {
  const store = useSignInStore();
  const email = useSelector(store, snapshot => snapshot.context.email);
  const signIn = useSignInWithCode();
  const sessionChanged = useSessionChanged();
  const defaultValues: CodeInput = { otp: '' };
  const form = useForm({
    defaultValues,
    validators: { onSubmit: CodeSchema },
    onSubmit: ({ value }) =>
      signIn.mutate(
        { email, otp: CodeSchema.parse(value).otp },
        { onSuccess: ({ offerPasskey }) => (offerPasskey ? store.trigger.offerPasskey() : sessionChanged()) }
      )
  });
  return (
    <PanelContent>
      <form
        onSubmit={event => {
          event.preventDefault();
          form.handleSubmit();
        }}
      >
        <FieldGroup>
          <form.Field name="otp">
            {field => (
              <OtpField
                field={field}
                label="Code from your email"
                description={`Sent to ${email}.`}
                groups={[6]}
                pattern={REGEXP_ONLY_DIGITS}
                onComplete={() => form.handleSubmit()}
                autoFocus
              />
            )}
          </form.Field>
          <FormError error={signIn.error} />
          <Button type="submit" loading={signIn.isPending}>
            Sign in
          </Button>
          <Button type="button" variant="ghost" onClick={() => store.trigger.showEmailForm({})}>
            Use a different email
          </Button>
        </FieldGroup>
      </form>
    </PanelContent>
  );
};
