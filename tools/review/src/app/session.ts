import { useQuery } from '@tanstack/react-query';
import type { Session } from '../shared/actions.ts';
import { sessionQuery } from './api.ts';

/** Who is signed in; undefined until known. */
export function useSession(): Session | undefined {
  return useQuery(sessionQuery).data;
}

/** Signing in leaves for GitHub and comes back to this page. */
export function signInHref(): string {
  return `/api/auth/login?to=${encodeURIComponent(window.location.pathname)}`;
}
