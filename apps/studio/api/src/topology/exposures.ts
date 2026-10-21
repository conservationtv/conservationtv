import { and, eq, notInArray, sql } from 'drizzle-orm';
import { exposures, gateways } from '../db/schema.ts';
import { ApiFailure } from '../errors.ts';
import type { Transaction } from '../organisations/membership.ts';
import { BUILTIN_GATEWAYS, isBuiltinGateway } from './gateways.ts';

// What the database cannot check about exposures on its own. An exposure's gateway is a built-in gateway's slug or one
// of its organisation's gateways, so no foreign key holds it: it must name a gateway that exists and accepts the
// exposure's protocol, and a gateway cannot go while exposures use it. A chain of upstreams must never loop. Each check
// runs after the write it guards, so a principal who may not write has already been refused by row-level security,
// and takes the lock that serialises it with the writes it races.

/** Refuses an exposure whose gateway is not there for its organisation, or does not accept its protocol. */
export async function checkGateway(tx: Transaction, organisationId: string, gatewayId: string, protocol: string) {
  if (isBuiltinGateway(gatewayId)) {
    const builtin: readonly string[] = BUILTIN_GATEWAYS[gatewayId].protocols;
    if (!builtin.includes(protocol)) throw new ApiFailure('unsupported_protocol');
    return;
  }
  // Shares the gateway's row lock, so a concurrent change to its protocols, or its removal, waits for this write, or
  // this for it.
  const [gateway] = await tx
    .select({ protocols: gateways.protocols })
    .from(gateways)
    .where(and(eq(gateways.organisationId, organisationId), eq(gateways.id, gatewayId)))
    .for('share');
  if (!gateway) throw new ApiFailure('invalid_reference');
  if (!gateway.protocols.includes(protocol)) throw new ApiFailure('unsupported_protocol');
}

/** Refuses removing a gateway, already deleted in this transaction, that exposures still use. */
export async function checkGatewayUnused(tx: Transaction, gatewayId: string) {
  const [used] = await tx
    .select({ id: exposures.id })
    .from(exposures)
    .where(eq(exposures.gatewayId, gatewayId))
    .limit(1);
  if (used) throw new ApiFailure('in_use');
}

/** Refuses a change to a gateway's protocols that would leave one of its exposures on a protocol it no longer accepts. */
export async function checkProtocolsInUse(tx: Transaction, gatewayId: string, protocols: string[]) {
  const [stranded] = await tx
    .select({ id: exposures.id })
    .from(exposures)
    .where(and(eq(exposures.gatewayId, gatewayId), notInArray(exposures.protocol, protocols)))
    .limit(1);
  if (stranded) throw new ApiFailure('in_use');
}

/** Refuses an exposure whose upstream chain, already written, leads back to it. */
export async function checkChain(tx: Transaction, streamId: string, exposureId: string) {
  // Upstreams change one stream's chain at a time: two concurrent changes could otherwise each close half a loop.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`exposure-chain:${streamId}`}, 0))`);
  const { rows } = await tx.execute(sql`
    with recursive chain(id) as (
      select ${exposures.upstreamExposureId} from ${exposures} where ${exposures.id} = ${exposureId}
      union
      select ${exposures.upstreamExposureId} from ${exposures} join chain on ${exposures.id} = chain.id
    )
    select 1 from chain where id = ${exposureId} limit 1
  `);
  if (rows.length > 0) throw new ApiFailure('exposure_cycle');
}
