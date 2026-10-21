import { and, eq, sql } from 'drizzle-orm';
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

/**
 * Serialises changes to one stream's exposures and recorders for the rest of the transaction: the checks below read
 * several of them, which two concurrent changes could each leave consistent alone and inconsistent together.
 */
async function lockStream(tx: Transaction, streamId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`stream-exposures:${streamId}`}, 0))`);
}

/** Refuses an exposure whose upstream chain, already written, leads back to it. */
export async function checkChain(tx: Transaction, streamId: string, exposureId: string) {
  await lockStream(tx, streamId);
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

const upstream = alias(exposures, 'upstream');
const downstream = alias(exposures, 'downstream');

/**
 * Refuses an exposure, already written, offering a rendition its upstream does not (`rendition_not_offered`), or no
 * longer offering one an exposure downstream of it or a recorder of it uses (`in_use`).
 */
export async function checkRenditions(tx: Transaction, streamId: string, exposureId: string) {
  await lockStream(tx, streamId);
  const [beyondUpstream] = await tx
    .select({ id: exposures.id })
    .from(exposures)
    .innerJoin(upstream, eq(upstream.id, exposures.upstreamExposureId))
    .where(and(eq(exposures.id, exposureId), sql`not (${exposures.renditions} <@ ${upstream.renditions})`));
  if (beyondUpstream) throw new ApiFailure('rendition_not_offered');
  const [stranded] = await tx
    .select({ id: downstream.id })
    .from(downstream)
    .innerJoin(exposures, eq(exposures.id, downstream.upstreamExposureId))
    .where(and(eq(exposures.id, exposureId), sql`not (${downstream.renditions} <@ ${exposures.renditions})`))
    .limit(1);
  if (stranded) throw new ApiFailure('in_use');
  const [unrecorded] = await tx
    .select({ id: recorders.id })
    .from(recorders)
    .innerJoin(exposures, eq(exposures.id, recorders.exposureId))
    .where(and(eq(exposures.id, exposureId), sql`not (${recorders.rendition} = any(${exposures.renditions}))`))
    .limit(1);
  if (unrecorded) throw new ApiFailure('in_use');
}

/** Refuses a recorder, already written, of a rendition its exposure does not offer. */
export async function checkRecorderRendition(tx: Transaction, streamId: string, recorderId: string) {
  await lockStream(tx, streamId);
  const [unoffered] = await tx
    .select({ id: recorders.id })
    .from(recorders)
    .innerJoin(exposures, eq(exposures.id, recorders.exposureId))
    .where(and(eq(recorders.id, recorderId), sql`not (${recorders.rendition} = any(${exposures.renditions}))`));
  if (unoffered) throw new ApiFailure('rendition_not_offered');
}
