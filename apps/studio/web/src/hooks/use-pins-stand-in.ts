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
 * What the about page's account menu shows. Signed out covers the session still loading, so sign-in is there straight
 * away; offline is a session (or pins) request that failed, after its retries.
 */
export type AccountMenuState = SignedOutMenu | OfflineMenu | SignedInMenu;

export interface SignedOutMenu {
  status: 'signed-out';
}

export interface OfflineMenu {
  status: 'offline';
}

export interface SignedInMenu {
  status: 'signed-in';
  pins: Pin[];
}

/**
 * The account menu's state: signed in once both the session and the pins have loaded. Never suspends or throws, so the
 * about page shows straight away and still shows with the studio API down.
 */
export function usePinsStandIn(): AccountMenuState {
  const sessionQuery = useQuery(sessionQueryOptions());
  const signedIn = Boolean(sessionQuery.data);
  const pinsQuery = useQuery({ ...pinsStandInQueryOptions(), enabled: signedIn });
  if (sessionQuery.isError || pinsQuery.isError) return { status: 'offline' };
  if (signedIn && pinsQuery.data) return { status: 'signed-in', pins: pinsQuery.data };
  return { status: 'signed-out' };
}
