import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import type { AccountUpdateParams } from '@conservationtv/studio-sdk';

import { api } from '@/lib/api';

export const accountQueries = {
  all: () => ['account'] as const,
  /** The signed-in account, as the studio API lets it see itself. */
  current: () =>
    queryOptions({
      queryKey: [...accountQueries.all(), 'current'] as const,
      queryFn: async () => {
        // The SDK returns its failures as values; TanStack Query needs them thrown.
        const account = await api.account.get.v1();
        if (account instanceof Error) throw account;
        return account;
      }
    })
};

/** Change the account's profile fields; the response is the updated account, so the cache takes it directly. */
export function useUpdateAccount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (changes: AccountUpdateParams) => {
      const account = await api.account.update.v1(changes);
      if (account instanceof Error) throw account;
      return account;
    },
    onSuccess: account => queryClient.setQueryData(accountQueries.current().queryKey, account)
  });
}
