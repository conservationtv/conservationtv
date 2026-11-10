// The about page's account menu doesn't suspend, so the page never waits on the session (approved exception).
// oxlint-disable-next-line no-restricted-imports
import { useQuery } from '@tanstack/react-query';

import type { Pins } from '@/lib/pins';
import { sessionQueryOptions } from '@/queries/session';
import { pinListQueryOptions } from '@/queries/this-device';

/**
 * What the about page's account menu shows. Signed out covers the session still loading, so sign-in is there straight
 * away; offline is a session request that failed, after its retries.
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
  /** The pages pinned to the app's rail on this browser. */
  pins: Pins;
}

/**
 * The account menu's state: signed in once the session has loaded, with this browser's pins. Never suspends or throws,
 * so the about page shows straight away and still shows with the studio API down.
 */
export function useAccountMenu(): AccountMenuState {
  const sessionQuery = useQuery(sessionQueryOptions());
  const signedIn = Boolean(sessionQuery.data);
  const pinsQuery = useQuery({ ...pinListQueryOptions(), enabled: signedIn });
  if (sessionQuery.isError) return { status: 'offline' };
  if (signedIn && pinsQuery.data) return { status: 'signed-in', pins: pinsQuery.data };
  return { status: 'signed-out' };
}
