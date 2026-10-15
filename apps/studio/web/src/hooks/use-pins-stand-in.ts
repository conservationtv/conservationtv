import { useSuspenseQuery } from '@tanstack/react-query';

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

/**
 * The signed-in person's pinned links, or null for anyone signed out. Whether someone is signed in is a local check, so
 * signed out it answers straight away; signed in, it suspends while the pins load (a stand-in pause). Settles once per
 * page load.
 */
export function usePinsStandIn() {
  const signedIn = isSignedInStandIn();
  return useSuspenseQuery<Pin[] | null>({
    queryKey: ['about', 'pins-stand-in', signedIn] as const,
    queryFn: () => new Promise(resolve => setTimeout(() => resolve(pins), DELAY_MS)),
    // Signed out, there's nothing to load: the answer is already known, so it doesn't suspend.
    initialData: signedIn ? undefined : null,
    staleTime: Infinity
  }).data;
}
