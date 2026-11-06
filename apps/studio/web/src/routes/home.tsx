import type { FC } from 'react';
import { useSuspenseQuery } from '@tanstack/react-query';
import { Navigate } from 'react-router';

import { Panel } from '@/components/common/panel';
import { organisationListQueryOptions } from '@/queries/organisations';

/**
 * Until the app keeps a current organisation, home opens the first one the account belongs to. An account in none
 * stays here.
 */
const HomeRoute: FC = () => {
  const organisationsQuery = useSuspenseQuery(organisationListQueryOptions());
  const [first] = organisationsQuery.data;
  if (first) return <Navigate to={`/organisations/${first.id}`} replace />;
  return <Panel title="No organisation" description="You aren’t a member of an organisation yet." />;
};

export default HomeRoute;
