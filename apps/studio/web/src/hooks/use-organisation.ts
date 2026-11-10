import { createContext, use } from 'react';
import { useSuspenseQuery } from '@tanstack/react-query';

import { ADMINISTRATOR_ROLE } from '@/components/settings/roles';
import { organisationListQueryOptions, organisationQueryOptions } from '@/queries/organisations';

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

/**
 * Whether the signed-in account administers the organisation this is rendered in, from the roles its organisation list
 * carries. Pages use it to offer what only an administrator may do; the API decides regardless. Suspends until the
 * list has loaded.
 */
export function useIsAdministrator(): boolean {
  const organisationId = useOrganisationId();
  const rolesQuery = useSuspenseQuery({
    ...organisationListQueryOptions(),
    select: organisations => organisations.find(organisation => organisation.id === organisationId)?.roles ?? []
  });
  return rolesQuery.data.some(role => role.id === ADMINISTRATOR_ROLE);
}
