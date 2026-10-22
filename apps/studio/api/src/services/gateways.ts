import { and, eq, sql } from 'drizzle-orm';
import { gateways } from '../db/schema.ts';
import { useDB } from '../db/transaction.ts';
import { checkGatewaySettings } from '../gateways/index.ts';
import { checkGatewayUnused } from '../topology/exposures.ts';
import type { Settings } from '../topology/settings.ts';
import { unchanged } from '../topology/transaction.ts';

// An organisation's own gateways. The built-in gateways (src/gateways/index.ts) are the deployment's, never rows, so
// they are listed beside these by the routes, not here. A gateway's settings are checked against its kind whenever
// either changes.

export interface GatewayFilter {
  /** Only gateways on this network. */
  networkId?: string;
}

export interface NewGateway {
  name: string;
  kind: string;
  networkId: string | null;
  settings: Settings;
}

export interface GatewayChanges {
  name?: string;
  kind?: string;
  networkId?: string | null;
  settings?: Settings;
}

/** The organisation's gateways, oldest first. */
export function listGateways(organisationId: string, filter: GatewayFilter) {
  const db = useDB();
  return db
    .select({
      id: gateways.id,
      builtin: sql<boolean>`false`,
      name: gateways.name,
      kind: gateways.kind,
      networkId: gateways.networkId,
      settings: gateways.settings,
      createdAt: gateways.createdAt
    })
    .from(gateways)
    .where(
      and(
        eq(gateways.organisationId, organisationId),
        filter.networkId === undefined ? undefined : eq(gateways.networkId, filter.networkId)
      )
    )
    .orderBy(gateways.id);
}

/** One of the organisation's gateways, if it is visible. */
export async function getGateway(organisationId: string, gatewayId: string) {
  const db = useDB();
  const [row] = await db
    .select({
      id: gateways.id,
      builtin: sql<boolean>`false`,
      name: gateways.name,
      kind: gateways.kind,
      networkId: gateways.networkId,
      settings: gateways.settings,
      createdAt: gateways.createdAt
    })
    .from(gateways)
    .where(and(eq(gateways.organisationId, organisationId), eq(gateways.id, gatewayId)));
  return row;
}

/** Add a gateway: `invalid_settings` or `unsupported_gateway` if its kind cannot take its settings. */
export async function createGateway(organisationId: string, payload: NewGateway) {
  const db = useDB();
  const [row] = await db
    .insert(gateways)
    .values({
      organisationId,
      name: payload.name,
      kind: payload.kind,
      networkId: payload.networkId,
      settings: payload.settings
    })
    .returning({
      id: gateways.id,
      builtin: sql<boolean>`false`,
      name: gateways.name,
      kind: gateways.kind,
      networkId: gateways.networkId,
      settings: gateways.settings,
      createdAt: gateways.createdAt
    });
  checkGatewaySettings(row!.kind, row!.settings);
  return row!;
}

/**
 * Change the gateway: `forbidden` or `not_found` when the write reaches no row, and its kind's refusal when a change to
 * its kind or settings leaves them unfit.
 */
export async function updateGateway(organisationId: string, gatewayId: string, changes: GatewayChanges) {
  const db = useDB();
  const [row] = await db
    .update(gateways)
    .set({ name: changes.name, kind: changes.kind, networkId: changes.networkId, settings: changes.settings })
    .where(and(eq(gateways.organisationId, organisationId), eq(gateways.id, gatewayId)))
    .returning({
      id: gateways.id,
      builtin: sql<boolean>`false`,
      name: gateways.name,
      kind: gateways.kind,
      networkId: gateways.networkId,
      settings: gateways.settings,
      createdAt: gateways.createdAt
    });
  if (!row) throw await unchanged(gateways.id, gatewayId);
  // Only a change to what its kind reads, the kind itself or its settings, can make them unfit.
  if (changes.kind !== undefined || changes.settings !== undefined) checkGatewaySettings(row.kind, row.settings);
  return row;
}

/** Remove the gateway: `forbidden` or `not_found` when the write reaches no row, `in_use` while exposures use it. */
export async function deleteGateway(organisationId: string, gatewayId: string) {
  const db = useDB();
  const deleted = await db
    .delete(gateways)
    .where(and(eq(gateways.organisationId, organisationId), eq(gateways.id, gatewayId)))
    .returning({ id: gateways.id });
  if (deleted.length === 0) throw await unchanged(gateways.id, gatewayId);
  await checkGatewayUnused(gatewayId);
}
