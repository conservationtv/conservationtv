// The about page's account menu doesn't suspend, so the page never waits on the session (approved exception).
// oxlint-disable-next-line no-restricted-imports
import { queryOptions, useQuery } from '@tanstack/react-query';

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

/** The pins, after a stand-in pause. */
const pinsStandInQueryOptions = () =>
  queryOptions<Pin[]>({
    queryKey: ['about', 'pins-stand-in'] as const,
    queryFn: () => new Promise(resolve => setTimeout(() => resolve(pins), DELAY_MS)),
    staleTime: Infinity
  });

/**
 * The signed-in person's pinned links, once both the session and the pins have loaded; undefined until then, and for
 * anyone signed out. Never suspends, so the about page shows straight away.
 */
export function usePinsStandIn() {
  const sessionQuery = useQuery(sessionQueryOptions());
  const signedIn = Boolean(sessionQuery.data);
  const pinsQuery = useQuery({ ...pinsStandInQueryOptions(), enabled: signedIn });
  return signedIn ? pinsQuery.data : undefined;
}
