import type { FC } from 'react';
import { useForm } from '@tanstack/react-form';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { Button } from '@conservationtv/ui/components/button';
import { Field, FieldGroup } from '@conservationtv/ui/components/field';

import { FormError } from '@/components/form-error';
import type { Route } from './+types/device';
import { PanelBody } from '@/components/panel';
import { SignInFrame } from '@/components/sign-in-frame';
import { SignIn } from '@/components/auth/sign-in';
import { Step, Steps } from '@/components/steps';
import { queryClient } from '@/lib/query-client';
import { DeviceCodeSchema, type DeviceCodeInput } from '@/forms/schemas';
import { OtpField } from '@/forms/otp-field';
import { REGEXP_ONLY_DIGITS_AND_CHARS } from 'input-otp';
import { useAnswerDevice, type DeviceDecision } from '@/queries/device';
import { sessionQueries } from '@/queries/session';
import { thisDeviceQueries } from '@/queries/this-device';

interface DecisionMeta {
  decision: DeviceDecision;
}

/**
 * The device-flow approval page the API points CLIs at (`/device?user_code=…`). Signing in here is the same sign-in
 * as everywhere else; approving binds the device's pending code to this account.
 */
export const meta: Route.MetaFunction = () => [{ title: 'Connect a device · conservation.tv studio' }];

/** Signed out is fine here: the page offers sign-in itself, then the approval form. */
export async function clientLoader() {
  await Promise.all([
    queryClient.query({ ...sessionQueries.current(), staleTime: 'static' }),
    queryClient.query({ ...thisDeviceQueries.accounts(), staleTime: 'static' })
  ]);
  return null;
}

/** One card for the whole page: signing in slides on to the approval form, which slides on to the outcome. */
const DeviceRoute: FC = () => {
  const { data: session } = useQuery(sessionQueries.current());
  return (
    <SignInFrame>
      <Steps active={session ? 'approve' : 'sign-in'}>
        <Step value="sign-in">
          <SignIn title="Sign in to connect a device" />
        </Step>
        <Step value="approve">{session && <DeviceForm email={session.user.email} />}</Step>
      </Steps>
    </SignInFrame>
  );
};

export default DeviceRoute;

interface DeviceFormProps {
  email: string;
}

const DeviceForm: FC<DeviceFormProps> = ({ email }) => {
  const [params] = useSearchParams();
  const answer = useAnswerDevice();
  const defaultValues: DeviceCodeInput = { userCode: params.get('user_code') ?? '' };
  const defaultMeta: DecisionMeta = { decision: 'approved' };
  const form = useForm({
    defaultValues,
    onSubmitMeta: defaultMeta,
    validators: { onSubmit: DeviceCodeSchema },
    onSubmit: ({ value, meta }) =>
      answer.mutate({ userCode: DeviceCodeSchema.parse(value).userCode, decision: meta.decision })
  });

  const pending: DeviceDecision | undefined = answer.isPending ? answer.variables.decision : undefined;
  return (
    <Steps active={answer.isSuccess ? answer.data : 'form'}>
      <Step value="form">
        <PanelBody
          title="Connect a device"
          description={`Signed in as ${email}. Enter the code the device shows, then approve it to let that device act as your account.`}
        >
          <form
            onSubmit={event => {
              event.preventDefault();
              form.handleSubmit({ decision: 'approved' });
            }}
          >
            <FieldGroup>
              <form.Field name="userCode">
                {field => (
                  <OtpField
                    field={field}
                    label="Device code"
                    groups={[4, 4]}
                    pattern={REGEXP_ONLY_DIGITS_AND_CHARS}
                    transform={value => value.toUpperCase()}
                  />
                )}
              </form.Field>
              <FormError error={answer.error} />
              <Field orientation="horizontal">
                <Button type="submit" loading={pending === 'approved'} disabled={pending !== undefined}>
                  Approve
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  loading={pending === 'denied'}
                  disabled={pending !== undefined}
                  onClick={() => form.handleSubmit({ decision: 'denied' })}
                >
                  Deny
                </Button>
              </Field>
            </FieldGroup>
          </form>
        </PanelBody>
      </Step>
      <Step value="approved">
        <PanelBody
          title="Device connected"
          description="You can close this page; the device will finish signing in on its own."
        />
      </Step>
      <Step value="denied">
        <PanelBody title="Request denied" description="The device was told it may not sign in as you." />
      </Step>
    </Steps>
  );
};
