import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';

import { authClient } from '@/lib/auth-client';
import { credentialIdsOf, withoutPasskeys, withPasskeys } from '@/lib/known-device';
import { PasskeyError } from '@/lib/passkey-error';
import { thisDeviceQueries, updateKnownAccounts } from '@/queries/this-device';

/** One of the signed-in account's passkeys, as Better Auth lists them. */
export type ListedPasskey = Awaited<ReturnType<typeof authClient.passkey.listUserPasskeys>>[number];

export const passkeyQueries = {
  all: () => ['passkeys'] as const,
  /** The signed-in account's registered passkeys. */
  list: () =>
    queryOptions({
      queryKey: [...passkeyQueries.all(), 'list'] as const,
      queryFn: () => authClient.passkey.listUserPasskeys()
    }),
  /**
   * Whether to offer "Keep me logged in for longer" to the signed-in account: the device can hold a passkey, and none
   * of the account's passkeys is one this browser holds. Comparing against the account's own list keeps this right
   * when several accounts use the same browser.
   */
  offer: () =>
    queryOptions({
      queryKey: [...passkeyQueries.all(), 'offer'] as const,
      queryFn: async ({ client }) => {
        const [platform, accounts, passkeys] = await Promise.all([
          client.query({ ...thisDeviceQueries.platformAuthenticator(), staleTime: 'static' }),
          client.query({ ...thisDeviceQueries.accounts(), staleTime: 'static' }),
          client.query({ ...passkeyQueries.list(), staleTime: 0 })
        ]);
        const known = new Set(credentialIdsOf(accounts));
        return platform && !passkeys.some(passkey => known.has(passkey.credentialID));
      },
      staleTime: 0
    })
};

export interface NewPasskey {
  name: string;
  /** The signed-in account's email, remembered beside the passkey so sign-in can offer "Continue as …". */
  email: string;
}

/**
 * Register this device's authenticator; the browser shows its own prompt. An authenticator that already holds one of
 * the account's passkeys refuses to make another ("previously registered"). That means this device can already sign
 * the account in, so it counts as success: the account's passkeys are remembered, since which of them is on this
 * device isn't revealed. Returns the credential IDs this browser now holds for the account.
 */
export function useAddPasskey() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ name }: NewPasskey) => {
      const result = await authClient.passkey.addPasskey({ name: name || undefined });
      if (!result.error) return [result.data.credentialID];
      const failure = new PasskeyError(result.error);
      if (failure.code !== 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED') throw failure;
      const passkeys = await client.query({ ...passkeyQueries.list(), staleTime: 0 });
      return passkeys.map(passkey => passkey.credentialID);
    },
    onSuccess: async (credentialIds, { email }) => {
      await updateKnownAccounts(client, accounts => withPasskeys(accounts, email, credentialIds));
      await client.invalidateQueries({ queryKey: passkeyQueries.all() });
    }
  });
}

export interface StoredPasskey {
  id: string;
  credentialID: string;
}

/** Remove a passkey from the account; this browser forgets it, keeping the account as an email-code one. */
export function useDeletePasskey() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: StoredPasskey) => authClient.passkey.deletePasskey({ id }),
    onSuccess: async (_result, { credentialID }) => {
      await updateKnownAccounts(client, accounts => withoutPasskeys(accounts, [credentialID]));
      await client.invalidateQueries({ queryKey: passkeyQueries.all() });
    }
  });
}
