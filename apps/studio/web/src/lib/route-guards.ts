import { redirect } from 'react-router';

import { queryClient } from '@/lib/query-client';
import { sessionQueries } from '@/queries/session';

/** For a clientLoader: the signed-in session, or a redirect to sign in that comes back to this URL. */
export async function requireSession(request: Request) {
  const session = await queryClient.query({ ...sessionQueries.current(), staleTime: 'static' });
  if (session) return session;
  const url = new URL(request.url);
  throw redirect(`/sign-in?redirect=${encodeURIComponent(url.pathname + url.search)}`);
}

/** Where to go after signing in: the `redirect` query parameter, kept on this site. */
export function signInDestination(params: URLSearchParams): string {
  const target = params.get('redirect') ?? '/';
  return target.startsWith('/') && !target.startsWith('//') ? target : '/';
}
