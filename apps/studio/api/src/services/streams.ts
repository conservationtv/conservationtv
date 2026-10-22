import { and, eq } from 'drizzle-orm';
import { exposures, recorders, streams } from '../db/schema.ts';
import { useDB } from '../db/transaction.ts';
import { ApiFailure } from '../errors.ts';
import { checkChain, checkGateway, checkRecorderRendition, checkRenditions } from '../topology/exposures.ts';
import type { ExposureParams, Rendition, Settings } from '../topology/settings.ts';
import { unchanged } from '../topology/transaction.ts';

// An organisation's streams, each with the exposures that deliver it and the recorders that record them. The database's
// composite foreign keys keep every reference inside one organisation, and stream; what they cannot check, an
// exposure's gateway (which may be built in), its upstream chain and the renditions along it, each write checks after
// it is made (src/topology/exposures.ts), so row-level security has refused a principal who may not first, and checks
// only what the change could break.

export interface NewStream {
  name: string;
  sourceDeviceId: string | null;
}

export interface StreamChanges {
  name?: string;
  sourceDeviceId?: string | null;
}

export interface NewExposure {
  gatewayId: string;
  renditions: Rendition[];
  publisherDeviceId: string | null;
  upstreamExposureId: string | null;
  params: ExposureParams;
}

export interface ExposureChanges {
  gatewayId?: string;
  renditions?: Rendition[];
  publisherDeviceId?: string | null;
  upstreamExposureId?: string | null;
  params?: ExposureParams;
}

export interface NewRecorder {
  exposureId: string;
  rendition: Rendition;
  kind: string;
  params: Settings;
}

export interface RecorderChanges {
  exposureId?: string;
  rendition?: Rendition;
  kind?: string;
  params?: Settings;
}

/** The organisation's streams, oldest first. */
export function listStreams(organisationId: string) {
  const db = useDB();
  return db
    .select({
      id: streams.id,
      name: streams.name,
      sourceDeviceId: streams.sourceDeviceId,
      createdAt: streams.createdAt
    })
    .from(streams)
    .where(eq(streams.organisationId, organisationId))
    .orderBy(streams.id);
}

/** The stream, if it is visible. */
export async function getStream(organisationId: string, streamId: string) {
  const db = useDB();
  const [row] = await db
    .select({
      id: streams.id,
      name: streams.name,
      sourceDeviceId: streams.sourceDeviceId,
      createdAt: streams.createdAt
    })
    .from(streams)
    .where(and(eq(streams.organisationId, organisationId), eq(streams.id, streamId)));
  return row;
}

export async function createStream(organisationId: string, payload: NewStream) {
  const db = useDB();
  const [row] = await db
    .insert(streams)
    .values({ organisationId, name: payload.name, sourceDeviceId: payload.sourceDeviceId })
    .returning({
      id: streams.id,
      name: streams.name,
      sourceDeviceId: streams.sourceDeviceId,
      createdAt: streams.createdAt
    });
  return row!;
}

/** Rename the stream, or change its source: `forbidden` or `not_found` when the write reaches no row. */
export async function updateStream(organisationId: string, streamId: string, changes: StreamChanges) {
  const db = useDB();
  const [row] = await db
    .update(streams)
    .set({ name: changes.name, sourceDeviceId: changes.sourceDeviceId })
    .where(and(eq(streams.organisationId, organisationId), eq(streams.id, streamId)))
    .returning({
      id: streams.id,
      name: streams.name,
      sourceDeviceId: streams.sourceDeviceId,
      createdAt: streams.createdAt
    });
  if (!row) throw await unchanged(streams.id, streamId);
  return row;
}

/** Delete the stream, with its exposures and recorders: `forbidden` or `not_found` when the write reaches no row. */
export async function deleteStream(organisationId: string, streamId: string) {
  const db = useDB();
  const deleted = await db
    .delete(streams)
    .where(and(eq(streams.organisationId, organisationId), eq(streams.id, streamId)))
    .returning({ id: streams.id });
  if (deleted.length === 0) throw await unchanged(streams.id, streamId);
}

/** The stream's exposures, oldest first. */
export function listExposures(organisationId: string, streamId: string) {
  const db = useDB();
  return db
    .select({
      id: exposures.id,
      gatewayId: exposures.gatewayId,
      renditions: exposures.renditions,
      publisherDeviceId: exposures.publisherDeviceId,
      upstreamExposureId: exposures.upstreamExposureId,
      params: exposures.params,
      createdAt: exposures.createdAt
    })
    .from(exposures)
    .where(and(eq(exposures.organisationId, organisationId), eq(exposures.streamId, streamId)))
    .orderBy(exposures.id);
}

/**
 * Expose the stream: `invalid_reference` for a gateway that is not there, and `rendition_not_offered` for a rendition
 * its upstream does not offer. A new exposure is no one's upstream yet, so its chain cannot loop.
 */
export async function createExposure(organisationId: string, streamId: string, payload: NewExposure) {
  const db = useDB();
  const [row] = await db
    .insert(exposures)
    .values({
      organisationId,
      streamId,
      gatewayId: payload.gatewayId,
      renditions: payload.renditions,
      publisherDeviceId: payload.publisherDeviceId,
      upstreamExposureId: payload.upstreamExposureId,
      params: payload.params
    })
    .returning({
      id: exposures.id,
      gatewayId: exposures.gatewayId,
      renditions: exposures.renditions,
      publisherDeviceId: exposures.publisherDeviceId,
      upstreamExposureId: exposures.upstreamExposureId,
      params: exposures.params,
      createdAt: exposures.createdAt
    });
  await checkGateway(organisationId, payload.gatewayId);
  if (payload.upstreamExposureId) await checkRenditions(row!.id);
  return row!;
}

/**
 * Change the exposure: `forbidden` or `not_found` when the write reaches no row, then what the change could break:
 * the gateway when it changed, the chain when it gained an upstream (`exposure_cycle`), and the renditions along it
 * when they or the upstream changed.
 */
export async function updateExposure(
  organisationId: string,
  streamId: string,
  exposureId: string,
  changes: ExposureChanges
) {
  const db = useDB();
  if (changes.upstreamExposureId === exposureId) throw new ApiFailure('exposure_cycle');
  const [row] = await db
    .update(exposures)
    .set({
      gatewayId: changes.gatewayId,
      renditions: changes.renditions,
      publisherDeviceId: changes.publisherDeviceId,
      upstreamExposureId: changes.upstreamExposureId,
      params: changes.params
    })
    .where(
      and(eq(exposures.organisationId, organisationId), eq(exposures.streamId, streamId), eq(exposures.id, exposureId))
    )
    .returning({
      id: exposures.id,
      gatewayId: exposures.gatewayId,
      renditions: exposures.renditions,
      publisherDeviceId: exposures.publisherDeviceId,
      upstreamExposureId: exposures.upstreamExposureId,
      params: exposures.params,
      createdAt: exposures.createdAt
    });
  if (!row) throw await unchanged(exposures.id, exposureId);
  if (changes.gatewayId !== undefined) await checkGateway(organisationId, row.gatewayId);
  if (changes.upstreamExposureId) await checkChain(streamId, exposureId);
  if (changes.renditions !== undefined || changes.upstreamExposureId !== undefined) await checkRenditions(exposureId);
  return row;
}

/** Remove the exposure: `forbidden` or `not_found` when the write reaches no row. */
export async function deleteExposure(organisationId: string, streamId: string, exposureId: string) {
  const db = useDB();
  const deleted = await db
    .delete(exposures)
    .where(
      and(eq(exposures.organisationId, organisationId), eq(exposures.streamId, streamId), eq(exposures.id, exposureId))
    )
    .returning({ id: exposures.id });
  if (deleted.length === 0) throw await unchanged(exposures.id, exposureId);
}

/** The stream's recorders, oldest first. */
export function listRecorders(organisationId: string, streamId: string) {
  const db = useDB();
  return db
    .select({
      id: recorders.id,
      exposureId: recorders.exposureId,
      rendition: recorders.rendition,
      kind: recorders.kind,
      params: recorders.params,
      createdAt: recorders.createdAt
    })
    .from(recorders)
    .where(and(eq(recorders.organisationId, organisationId), eq(recorders.streamId, streamId)))
    .orderBy(recorders.id);
}

/** Record one of the renditions an exposure of the stream offers: `rendition_not_offered` for one it does not. */
export async function createRecorder(organisationId: string, streamId: string, payload: NewRecorder) {
  const db = useDB();
  const [row] = await db
    .insert(recorders)
    .values({
      organisationId,
      streamId,
      exposureId: payload.exposureId,
      rendition: payload.rendition,
      kind: payload.kind,
      params: payload.params
    })
    .returning({
      id: recorders.id,
      exposureId: recorders.exposureId,
      rendition: recorders.rendition,
      kind: recorders.kind,
      params: recorders.params,
      createdAt: recorders.createdAt
    });
  await checkRecorderRendition(row!.id);
  return row!;
}

/**
 * Change the recorder: `forbidden` or `not_found` when the write reaches no row, and `rendition_not_offered` when
 * what it records changed to a rendition its exposure does not offer.
 */
export async function updateRecorder(
  organisationId: string,
  streamId: string,
  recorderId: string,
  changes: RecorderChanges
) {
  const db = useDB();
  const [row] = await db
    .update(recorders)
    .set({ exposureId: changes.exposureId, rendition: changes.rendition, kind: changes.kind, params: changes.params })
    .where(
      and(eq(recorders.organisationId, organisationId), eq(recorders.streamId, streamId), eq(recorders.id, recorderId))
    )
    .returning({
      id: recorders.id,
      exposureId: recorders.exposureId,
      rendition: recorders.rendition,
      kind: recorders.kind,
      params: recorders.params,
      createdAt: recorders.createdAt
    });
  if (!row) throw await unchanged(recorders.id, recorderId);
  if (changes.exposureId !== undefined || changes.rendition !== undefined) await checkRecorderRendition(recorderId);
  return row;
}

/** Remove the recorder: `forbidden` or `not_found` when the write reaches no row. */
export async function deleteRecorder(organisationId: string, streamId: string, recorderId: string) {
  const db = useDB();
  const deleted = await db
    .delete(recorders)
    .where(
      and(eq(recorders.organisationId, organisationId), eq(recorders.streamId, streamId), eq(recorders.id, recorderId))
    )
    .returning({ id: recorders.id });
  if (deleted.length === 0) throw await unchanged(recorders.id, recorderId);
}
