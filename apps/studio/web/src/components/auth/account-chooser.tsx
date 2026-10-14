import type { FC } from 'react';
import { motion } from 'motion/react';
import { Button } from '@conservationtv/ui/components/button';
import { FieldGroup } from '@conservationtv/ui/components/field';

import { AccountButton } from '@/components/auth/account-button';
import { FormError } from '@/components/common/form-error';
import { PanelContent } from '@/components/common/panel';
import type { KnownAccount, KnownAccounts } from '@/lib/known-device';
import { useSendSignInCode, useSignInWithPasskey } from '@/queries/session';
import { useSignInStore } from '@/stores/sign-in';

export interface AccountChooserProps {
  accounts: KnownAccounts;
}

/** The accounts this browser has signed in, most recent first; one is in progress at a time. */
export const AccountChooser: FC<AccountChooserProps> = ({ accounts }) => {
  const store = useSignInStore();
  const passkey = useSignInWithPasskey();
  const send = useSendSignInCode();
  // Only a passkey sign-in shows as pending: it waits on the person, and its row spins. Sending a code is quick and
  // moves straight on to the code step, so it shows nothing (a spinner would only flash); clicks meanwhile are ignored.
  const pending = passkey.isPending ? passkey.variables.email : undefined;
  const busy = passkey.isPending || send.isPending;
  return (
    <PanelContent>
      <FieldGroup>
        <div className="flex flex-col gap-2">
          {accounts.map((account, index) => (
            // Each row follows the card in, a beat after the one above it. A column, so the button still fills the row.
            <motion.div
              key={account.email}
              className="flex flex-col"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.35, delay: 0.12 + index * 0.06, ease: [0.22, 1, 0.36, 1] }}
            >
              <KnownAccountRow
                account={account}
                pending={pending}
                onPasskey={() => {
                  if (busy) return;
                  passkey.mutate(account, { onError: () => store.trigger.showEmailForm({ prefill: account.email }) });
                }}
                onCode={() => {
                  if (busy) return;
                  send.mutate(
                    { email: account.email },
                    { onSuccess: () => store.trigger.codeSent({ email: account.email }) }
                  );
                }}
              />
            </motion.div>
          ))}
        </div>
        <FormError error={send.error} />
        <Button type="button" variant="ghost" onClick={() => store.trigger.showEmailForm({})}>
          Use a different account
        </Button>
      </FieldGroup>
    </PanelContent>
  );
};

interface KnownAccountRowProps {
  account: KnownAccount;
  /** The account whose passkey sign-in is in progress, if any: its row spins, the others wait. */
  pending: string | undefined;
  onPasskey: () => void;
  onCode: () => void;
}

/** A passkey account signs in with its passkey; an email-only one is sent a code. */
const KnownAccountRow: FC<KnownAccountRowProps> = ({ account, pending, onPasskey, onCode }) => {
  const hasPasskey = account.credentialIds.length > 0;
  return (
    <AccountButton
      email={account.email}
      hint={hasPasskey ? 'Sign in with this device' : 'Email me a code'}
      loading={pending === account.email}
      disabled={pending !== undefined}
      onClick={hasPasskey ? onPasskey : onCode}
    />
  );
};
