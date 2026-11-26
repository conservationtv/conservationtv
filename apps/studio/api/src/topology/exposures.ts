import { and, eq, sql } from 'drizzle-orm';
import { exposures, gateways, outputPreviews, outputs } from '../db/schema.ts';
import { ApiFailure } from '../errors.ts';
import { useDB } from '../db/transaction.ts';
import { isBuiltinGateway } from '../gateways/index.ts';

// What the database cannot check about exposures on its own. An exposure's gateway, as a show's preview's, is a built-in
// gateway's slug or one of its organisation's gateways, so no foreign key holds it: it must name a gateway that exists,
// and a gateway cannot go while exposures or previews use it, or an output reads from it. A chain of upstreams must
// never loop. Each check runs after the write it guards, so a principal who may not write has already been refused by
// row-level security, and takes the lock that serialises it with the writes it races.

/** Refuses an exposure or preview whose gateway is not there for its organisation. */
export async function checkGateway(organisationId: string, gatewayId: string) {
  const db = useDB();
  if (isBuiltinGateway(gatewayId)) return;
  // Shares the gateway's row lock, so its concurrent removal waits for this write, or this for it.
  const [gateway] = await db
    .select({ id: gateways.id })
    .from(gateways)
    .where(and(eq(gateways.organisationId, organisationId), eq(gateways.id, gatewayId)))
    .for('share');
  if (!gateway) throw new ApiFailure('invalid_reference');
}

/**
 * Refuses removing a gateway, already deleted in this transaction, that exposures or previews still use, or that an
 * output reads every stream from.
 */
export async function checkGatewayUnused(gatewayId: string) {
  const db = useDB();
  const [used] = await db
    .select({ id: exposures.id })
    .from(exposures)
    .where(eq(exposures.gatewayId, gatewayId))
    .limit(1);
  if (used) throw new ApiFailure('in_use');
  const [previewed] = await db
    .select({ id: outputPreviews.id })
    .from(outputPreviews)
    .where(eq(outputPreviews.gatewayId, gatewayId))
    .limit(1);
  if (previewed) throw new ApiFailure('in_use');
  const [input] = await db
    .select({ id: outputs.id })
    .from(outputs)
    .where(eq(outputs.inputGatewayId, gatewayId))
    .limit(1);
  if (input) throw new ApiFailure('in_use');
}

/** Refuses an exposure whose upstream chain, already written, leads back to it. */
export async function checkChain(streamId: string, exposureId: string) {
  const db = useDB();
  // Upstreams change one stream's chain at a time: two concurrent changes could otherwise each close half a loop.
  await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`exposure-chain:${streamId}`}, 0))`);
  const { rows } = await db.execute(sql`
    with recursive chain(id) as (
      select ${exposures.upstreamExposureId} from ${exposures} where ${exposures.id} = ${exposureId}
      union
      select ${exposures.upstreamExposureId} from ${exposures} join chain on ${exposures.id} = chain.id
    )
    select 1 from chain where id = ${exposureId} limit 1
  `);
  if (rows.length > 0) throw new ApiFailure('exposure_cycle');
}
