import type { FC } from 'react';
import { useSuspenseQuery } from '@tanstack/react-query';
import { Navigate, useSearchParams } from 'react-router';

import type { Route } from './+types/sign-in';
import { SignIn } from '@/components/auth/sign-in';
import { SignInFrame } from '@/components/auth/sign-in-frame';
import { signInDestination } from '@/lib/route-guards';
import { sessionQueryOptions } from '@/queries/session';

export const meta: Route.MetaFunction = () => [{ title: 'Sign in · conservation.tv studio' }];

/**
 * Already signed in: go straight on. Signing in refreshes the session query; once it holds a session, continue to the
 * requested page.
 */
const SignInRoute: FC = () => {
  const [params] = useSearchParams();
  const { data: session } = useSuspenseQuery(sessionQueryOptions());
  if (session) return <Navigate to={signInDestination(params)} replace />;
  return (
    <SignInFrame>
      <SignIn />
    </SignInFrame>
  );
};

export default SignInRoute;
