import { and, eq, sql } from 'drizzle-orm';
import { gateways } from '../db/schema.ts';
import { useDB } from '../db/transaction.ts';
import type { ProviderState } from '../topology/settings.ts';

// What an organisation's gateway keeps hidden from request sessions (src/db/schemas/gateways.ts): the credentials its
// administrators gave its provider, and the state the provider keeps for itself. Only trusted code reads them, in a
// trusted transaction, and only providers write the state.

/** The gateway's settings, credentials and provider state, if it exists. */
export async function selectGatewaySecrets(organisationId: string, gatewayId: string) {
  const db = useDB({ trusted: true });
  const [row] = await db
    .select({ settings: gateways.settings, credentials: gateways.credentials, state: gateways.providerState })
    .from(gateways)
    .where(and(eq(gateways.organisationId, organisationId), eq(gateways.id, gatewayId)));
  return row;
}
export type GatewaySecrets = NonNullable<Awaited<ReturnType<typeof selectGatewaySecrets>>>;

/**
 * Waits for the gateway's provider-state lock, held until the trusted transaction ends, so one caller at a time
 * changes what the provider keeps for it.
 */
export async function lockProviderState(gatewayId: string): Promise<void> {
  const db = useDB({ trusted: true });
  await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`gateway-provider-state:${gatewayId}`}, 0))`);
}

/** Replaces what the provider keeps for the gateway. */
export async function writeProviderState(gatewayId: string, state: ProviderState): Promise<void> {
  const db = useDB({ trusted: true });
  await db.update(gateways).set({ providerState: state }).where(eq(gateways.id, gatewayId));
}
