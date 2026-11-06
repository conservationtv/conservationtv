import { queryOptions, useSuspenseQuery } from '@tanstack/react-query';

import { isSignedInStandIn } from '@/lib/signed-in-stand-in';

/** How long the stand-in waits, in milliseconds: about as long as fetching the pins takes. */
const DELAY_MS = 200;

export interface Pin {
  to: string;
  label: string;
}

/** Placeholder pins, as the app rail shows them. */
const pins: Pin[] = [
  { to: '/account', label: 'Alveus Sanctuary' },
  { to: '/account', label: 'Your settings' }
];

/** The pins, after a stand-in pause; signed out, there's nothing to load, so the answer is known and doesn't wait. */
const pinsStandInQueryOptions = (signedIn: boolean) =>
  queryOptions<Pin[] | null>({
    queryKey: ['about', 'pins-stand-in', signedIn] as const,
    queryFn: () => new Promise(resolve => setTimeout(() => resolve(pins), DELAY_MS)),
    initialData: signedIn ? undefined : null,
    staleTime: Infinity
  });

/**
 * The signed-in person's pinned links, or null for anyone signed out. Whether someone is signed in is a local check, so
 * signed out it answers straight away; signed in, it suspends while the pins load (a stand-in pause). Settles once per
 * page load.
 */
export function usePinsStandIn() {
  const signedIn = isSignedInStandIn();
  const pinsQuery = useSuspenseQuery(pinsStandInQueryOptions(signedIn));
  return pinsQuery.data;
}
