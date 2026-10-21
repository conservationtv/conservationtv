import { and, arrayContained, eq, not, notInArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { exposures, gateways, recorders } from '../db/schema.ts';
import { ApiFailure } from '../errors.ts';
import type { Transaction } from '../organisations/membership.ts';
import { isBuiltinGateway } from '../gateways/index.ts';

// What the database cannot check about exposures on its own. An exposure's gateway is a built-in gateway's slug or one
// of its organisation's gateways, so no foreign key holds it: it must name a gateway that exists, and a gateway cannot
// go while exposures use it. A chain of upstreams must never loop, and offers at each step at most the renditions of
// the step before, as a recorder records only a rendition its exposure offers. Each check runs after the write it
// guards, so a principal who may not write has already been refused by row-level security, and takes the lock that
// serialises it with the writes it races.

/** Refuses an exposure whose gateway is not there for its organisation. */
export async function checkGateway(tx: Transaction, organisationId: string, gatewayId: string) {
  if (isBuiltinGateway(gatewayId)) return;
  // Shares the gateway's row lock, so its concurrent removal waits for this write, or this for it.
  const [gateway] = await tx
    .select({ id: gateways.id })
    .from(gateways)
    .where(and(eq(gateways.organisationId, organisationId), eq(gateways.id, gatewayId)))
    .for('share');
  if (!gateway) throw new ApiFailure('invalid_reference');
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

/**
 * The renditions an exposure offers, sharing its row lock: a concurrent change to them waits for this transaction, or
 * this read for that change, and then sees it.
 */
async function offeredRenditions(tx: Transaction, exposureId: string) {
  const [exposure] = await tx
    .select({ renditions: exposures.renditions })
    .from(exposures)
    .where(eq(exposures.id, exposureId))
    .for('share');
  return exposure?.renditions ?? [];
}

const downstream = alias(exposures, 'downstream');

/**
 * Refuses an exposure, already written, offering a rendition its upstream does not (`rendition_not_offered`), or no
 * longer offering one an exposure downstream of it or a recorder of it uses (`in_use`). Writing the exposure locked its
 * row, which a downstream exposure or recorder shares to check it: one checked first has committed before that write,
 * so is read here, and one checked after waits for this transaction, and then sees what it leaves.
 */
export async function checkRenditions(tx: Transaction, exposureId: string) {
  const [exposure] = await tx
    .select({ renditions: exposures.renditions, upstreamExposureId: exposures.upstreamExposureId })
    .from(exposures)
    .where(eq(exposures.id, exposureId));
  if (!exposure) return;
  if (exposure.upstreamExposureId !== null) {
    const offered = await offeredRenditions(tx, exposure.upstreamExposureId);
    if (exposure.renditions.some(rendition => !offered.includes(rendition))) {
      throw new ApiFailure('rendition_not_offered');
    }
  }
  const [stranded] = await tx
    .select({ id: downstream.id })
    .from(downstream)
    .where(
      and(
        eq(downstream.upstreamExposureId, exposureId),
        not(arrayContained(downstream.renditions, exposure.renditions))
      )
    )
    .limit(1);
  if (stranded) throw new ApiFailure('in_use');
  const [unrecorded] = await tx
    .select({ id: recorders.id })
    .from(recorders)
    .where(and(eq(recorders.exposureId, exposureId), notInArray(recorders.rendition, exposure.renditions)))
    .limit(1);
  if (unrecorded) throw new ApiFailure('in_use');
}

/** Refuses a recorder, already written, of a rendition its exposure does not offer. */
export async function checkRecorderRendition(tx: Transaction, recorderId: string) {
  const [recorder] = await tx
    .select({ exposureId: recorders.exposureId, rendition: recorders.rendition })
    .from(recorders)
    .where(eq(recorders.id, recorderId));
  if (!recorder) return;
  const offered = await offeredRenditions(tx, recorder.exposureId);
  if (!offered.includes(recorder.rendition)) throw new ApiFailure('rendition_not_offered');
}
