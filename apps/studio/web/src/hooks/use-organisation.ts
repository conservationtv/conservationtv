import { createContext, use } from 'react';
import { useSuspenseQuery } from '@tanstack/react-query';

import { organisationQueryOptions } from '@/queries/organisations';

/**
 * Which organisation everything below the organisation layout is in: its ID, as the layout's route names it. Only the
 * identity lives here; what the organisation is comes from the query cache (`useOrganisation`).
 */
export const OrganisationContext = createContext<string | null>(null);

function outsideOrganisation(): never {
  throw new Error('This is only for components under the organisation layout (<OrganisationContext>).');
}

/** The ID of the organisation this is rendered in. */
export function useOrganisationId(): string {
  return use(OrganisationContext) ?? outsideOrganisation();
}

/**
 * The organisation this is rendered in. Suspends until it has loaded (the layout starts it loading), so put a boundary
 * around just the part that reads it.
 */
export function useOrganisation() {
  const organisationId = useOrganisationId();
  const organisationQuery = useSuspenseQuery(organisationQueryOptions(organisationId));
  return organisationQuery.data;
}
