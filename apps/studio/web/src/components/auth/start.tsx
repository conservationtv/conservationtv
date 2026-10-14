import type { FC } from 'react';
import { useQuery } from '@tanstack/react-query';

import { AccountChooser } from '@/components/auth/account-chooser';
import { EmailStep } from '@/components/auth/email-step';
import { thisDeviceQueries } from '@/queries/this-device';

/** The remembered accounts, or straight to the email form when there are none. */
export const Start: FC = () => {
  const accounts = useQuery(thisDeviceQueries.accounts());
  if (accounts.isPending) return null;
  if (accounts.data?.length) return <AccountChooser accounts={accounts.data} />;
  return <EmailStep />;
};
