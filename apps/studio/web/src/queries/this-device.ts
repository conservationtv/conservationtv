import { queryOptions, useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';

import { readKnownAccounts, writeKnownAccounts, type KnownAccounts } from '@/lib/known-device';
import { readPins, withoutPin, withPinToggled, writePins, type Pin } from '@/lib/pins';

// What this browser knows and can do, independent of who is signed in: kept when the session changes, under the
// 'this-device' key segment.

/** The accounts that have signed in here, most recent first; see src/lib/known-device.ts. */
export const knownAccountsQueryOptions = () =>
  queryOptions({
    queryKey: ['this-device', 'accounts'] as const,
    queryFn: async () => readKnownAccounts(),
    staleTime: Infinity
  });

/** Whether the device has a built-in authenticator (Face ID, Touch ID, Windows Hello, a screen-lock PIN). */
export const platformAuthenticatorQueryOptions = () =>
  queryOptions({
    queryKey: ['this-device', 'platform-authenticator'] as const,
    queryFn: async () =>
      'PublicKeyCredential' in window &&
      (await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable().catch(() => false)),
    staleTime: Infinity
  });

/**
 * Update this browser's account record from inside a mutation: the record is read through its query, written to
 * storage, and the query's cache set to the result, so everything showing it updates at once.
 */
export async function updateKnownAccounts(
  client: QueryClient,
  update: (accounts: KnownAccounts) => KnownAccounts
): Promise<void> {
  const current = await client.query({ ...knownAccountsQueryOptions(), staleTime: 'static' });
  const next = update(current);
  writeKnownAccounts(next);
  client.setQueryData(knownAccountsQueryOptions().queryKey, next);
}

/** The pages pinned to the app's rail on this browser, oldest first; see src/lib/pins.ts. */
export const pinListQueryOptions = () =>
  queryOptions({
    queryKey: ['this-device', 'pins'] as const,
    queryFn: async () => readPins(),
    staleTime: Infinity
  });

/** Pin a page to the rail, or unpin it if it is there: written to storage, and the query's cache set to the result. */
export function useTogglePin() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (pin: Pin) => {
      const current = await client.query({ ...pinListQueryOptions(), staleTime: 'static' });
      const next = withPinToggled(current, pin);
      writePins(next);
      return next;
    },
    onSuccess: pins => client.setQueryData(pinListQueryOptions().queryKey, pins)
  });
}

/** Take a page off the rail by its path, if it is pinned: for when what the page was about has been deleted. */
export function useRemovePin() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (to: string) => {
      const current = await client.query({ ...pinListQueryOptions(), staleTime: 'static' });
      const next = withoutPin(current, to);
      writePins(next);
      return next;
    },
    onSuccess: pins => client.setQueryData(pinListQueryOptions().queryKey, pins)
  });
}
