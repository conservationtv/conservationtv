import type { FC } from 'react';
import { Navigate } from 'react-router';

/** An organisation opens on its streams, until it has a page of its own. */
const OrganisationHomeRoute: FC = () => {
  return <Navigate to="streams" replace />;
};

export default OrganisationHomeRoute;
