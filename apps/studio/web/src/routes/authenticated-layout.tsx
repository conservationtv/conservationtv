import type { FC } from 'react';
import { useSuspenseQuery } from '@tanstack/react-query';
import { Navigate, Outlet, useLocation } from 'react-router';

import { signInPath } from '@/lib/route-guards';
import { sessionQueryOptions } from '@/queries/session';

/**
 * Signed-in only, for every route under it: suspends while the session loads, then sends anyone signed out to sign in
 * and back to where they were going.
 */
const AuthenticatedLayout: FC = () => {
  const location = useLocation();
  const sessionQuery = useSuspenseQuery(sessionQueryOptions());
  if (!sessionQuery.data) return <Navigate to={signInPath(location)} replace />;
  return <Outlet />;
};

export default AuthenticatedLayout;
