import { and, eq } from 'drizzle-orm';
import { organisationProviders, platformProviders } from '../db/schema.ts';
import { ApiFailure } from '../errors.ts';
import type { Transaction } from '../organisations/membership.ts';

/**
 * The registration columns for a provider ID: one of the organisation's own registrations, or one the platform offers.
 * The API names a provider by ID alone; the database keeps the two kinds in separate tables, and a composite foreign
 * key keeps an organisation's registrations to itself. `null` means no provider, such as a local exposure.
 */
export async function providerColumns(tx: Transaction, organisationId: string, providerId: string | null) {
  if (providerId === null) return { platformProviderId: null, organisationProviderId: null };
  const [own] = await tx
    .select({ id: organisationProviders.id })
    .from(organisationProviders)
    .where(and(eq(organisationProviders.organisationId, organisationId), eq(organisationProviders.id, providerId)));
  if (own) return { platformProviderId: null, organisationProviderId: own.id };
  const [platform] = await tx
    .select({ id: platformProviders.id })
    .from(platformProviders)
    .where(eq(platformProviders.id, providerId));
  if (platform) return { platformProviderId: platform.id, organisationProviderId: null };
  throw new ApiFailure('invalid_reference');
}
