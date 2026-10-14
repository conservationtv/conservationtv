import type { FC } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Navigate, redirect, useSearchParams } from 'react-router';

import type { Route } from './+types/sign-in';
import { SignIn } from '@/components/auth/sign-in';
import { SignInFrame } from '@/components/auth/sign-in-frame';
import { queryClient } from '@/lib/query-client';
import { signInDestination } from '@/lib/route-guards';
import { sessionQueries } from '@/queries/session';
import { thisDeviceQueries } from '@/queries/this-device';

export const meta: Route.MetaFunction = () => [{ title: 'Sign in · conservation.tv studio' }];

/** Already signed in: go straight on. Otherwise this browser's remembered accounts are read before the page shows. */
export async function clientLoader({ request }: Route.ClientLoaderArgs) {
  const session = await queryClient.query({ ...sessionQueries.current(), staleTime: 'static' });
  if (session) throw redirect(signInDestination(new URL(request.url).searchParams));
  await queryClient.query({ ...thisDeviceQueries.accounts(), staleTime: 'static' });
  return null;
}

/** Signing in refreshes the session query; once it holds a session, continue to the requested page. */
const SignInRoute: FC = () => {
  const [params] = useSearchParams();
  const { data: session } = useQuery(sessionQueries.current());
  if (session) return <Navigate to={signInDestination(params)} replace />;
  return (
    <SignInFrame>
      <SignIn />
    </SignInFrame>
  );
};

export default SignInRoute;
