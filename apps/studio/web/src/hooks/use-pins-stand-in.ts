import { queryOptions, useSuspenseQuery } from '@tanstack/react-query';

import { sessionQueryOptions } from '@/queries/session';

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
 * The signed-in person's pinned links, or null for anyone signed out. Suspends while the session loads; signed in, it
 * then suspends again while the pins load (still a stand-in pause).
 */
export function usePinsStandIn() {
  const sessionQuery = useSuspenseQuery(sessionQueryOptions());
  const signedIn = Boolean(sessionQuery.data);
  const pinsQuery = useSuspenseQuery(pinsStandInQueryOptions(signedIn));
  return pinsQuery.data;
}
