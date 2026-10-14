import type { FC } from 'react';
import { useSelector } from '@xstate/store-react';
import { Button } from '@conservationtv/ui/components/button';
import { FieldGroup } from '@conservationtv/ui/components/field';

import { FormError } from '@/components/form-error';
import { PanelContent, PanelHeader } from '@/components/panel';
import { useAddPasskey } from '@/queries/passkeys';
import { useSessionChanged } from '@/queries/session';
import { useSignInStore } from '@/stores/sign-in';

/** Offered after a code sign-in. "Not now" applies to this sign-in only; nothing is remembered. */
export const RememberDevice: FC = () => {
  const email = useSelector(useSignInStore(), snapshot => snapshot.context.email);
  const add = useAddPasskey();
  const sessionChanged = useSessionChanged();
  return (
    <>
      <PanelHeader
        title="You're signed in"
        description="Next time, skip the email code and sign in on this device the way you unlock it."
      />
      <PanelContent>
        <FieldGroup>
          <Button
            type="button"
            loading={add.isPending}
            onClick={() => add.mutate({ name: '', email }, { onSuccess: sessionChanged })}
          >
            Keep me logged in for longer
          </Button>
          <Button type="button" variant="ghost" disabled={add.isPending} onClick={sessionChanged}>
            Not now
          </Button>
          <FormError error={add.error} />
        </FieldGroup>
      </PanelContent>
    </>
  );
};
