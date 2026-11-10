import { device } from '@conservationtv/umbrella';
import { and, eq } from 'drizzle-orm';
import { channelBroadcaster } from '../db/roles.ts';
import { showForwards, showOutputs, showPreviews, showRecorders, shows } from '../db/schema.ts';
import { useAccess, useDB } from '../db/transaction.ts';
import { checkGateway } from '../topology/exposures.ts';
import type { Settings } from '../topology/settings.ts';
import type { ShowRecorderKind } from '../topology/show-recorder-kinds.ts';
import { unchanged } from '../topology/transaction.ts';
import { organisationScope } from './organisations.ts';

// An organisation's shows going out (src/db/schemas/shows.ts), each with its output, forwards, previews and recorders,
// in the principal's request session: members read them, administrators manage them. The database's composite foreign
// keys keep every reference inside one organisation; a preview's gateway, which may be built in, is checked after each
// write (src/topology/exposures.ts), as an exposure's is. Which show a device is the output of is read by trusted code,
// as a device principal cannot read the topology. Each show's output is granted `channelBroadcaster`, to read the stream
// keys of the channels it forwards to, for as long as it is an output, and no longer (`syncBroadcasters`).

/** A show's programme encoding: what OBS encodes it as. */
export interface ShowEncoding {
  width: number;
  height: number;
  fps: number;
  bitrateKbps: number;
  keyframeSeconds: number;
}

export interface NewShow extends Partial<ShowEncoding> {
  name: string;
}

export interface ShowChanges extends Partial<ShowEncoding> {
  name?: string;
}

export interface NewShowForward {
  channelId: string;
  enabled: boolean;
}

export interface NewShowRecorder {
  kind: ShowRecorderKind;
  params: Settings;
}

export interface ShowRecorderChanges {
  kind?: ShowRecorderKind;
  params?: Settings;
}

/** The organisation's shows, oldest first, each with its output (or null) and its forwards, previews and recorders. */
export function listShows(organisationId: string) {
  const db = useDB();
  return db.query.shows.findMany({
    columns: {
      id: true,
      name: true,
      width: true,
      height: true,
      fps: true,
      bitrateKbps: true,
      keyframeSeconds: true,
      createdAt: true
    },
    with: {
      output: { columns: { deviceId: true, createdAt: true } },
      forwards: { columns: { id: true, channelId: true, enabled: true, createdAt: true }, orderBy: { id: 'asc' } },
      previews: { columns: { id: true, gatewayId: true, createdAt: true }, orderBy: { id: 'asc' } },
      recorders: { columns: { id: true, kind: true, params: true, createdAt: true }, orderBy: { id: 'asc' } }
    },
    where: { organisationId },
    orderBy: { id: 'asc' }
  });
}

/** The show, with its output and its forwards, previews and recorders, if it is visible. */
export function getShowWithTopology(organisationId: string, showId: string) {
  const db = useDB();
  return db.query.shows.findFirst({
    columns: {
      id: true,
      name: true,
      width: true,
      height: true,
      fps: true,
      bitrateKbps: true,
      keyframeSeconds: true,
      createdAt: true
    },
    with: {
      output: { columns: { deviceId: true, createdAt: true } },
      forwards: { columns: { id: true, channelId: true, enabled: true, createdAt: true }, orderBy: { id: 'asc' } },
      previews: { columns: { id: true, gatewayId: true, createdAt: true }, orderBy: { id: 'asc' } },
      recorders: { columns: { id: true, kind: true, params: true, createdAt: true }, orderBy: { id: 'asc' } }
    },
    where: { organisationId, id: showId }
  });
}

/** Whether the show is visible: what its hops' writes check first, so a show that is not there is `not_found`. */
export async function showVisible(organisationId: string, showId: string) {
  const db = useDB();
  const [row] = await db
    .select({ id: shows.id })
    .from(shows)
    .where(and(eq(shows.organisationId, organisationId), eq(shows.id, showId)));
  return row !== undefined;
}

/** Create a show, its encoding the defaults where not given. */
export async function createShow(organisationId: string, payload: NewShow) {
  const db = useDB();
  const [row] = await db
    .insert(shows)
    .values({ organisationId, ...payload })
    .returning({
      id: shows.id,
      name: shows.name,
      width: shows.width,
      height: shows.height,
      fps: shows.fps,
      bitrateKbps: shows.bitrateKbps,
      keyframeSeconds: shows.keyframeSeconds,
      createdAt: shows.createdAt
    });
  return row!;
}

/** Rename the show, or change its encoding: `forbidden` or `not_found` when the write reaches no row. */
export async function updateShow(organisationId: string, showId: string, changes: ShowChanges) {
  const db = useDB();
  const [row] = await db
    .update(shows)
    .set({
      name: changes.name,
      width: changes.width,
      height: changes.height,
      fps: changes.fps,
      bitrateKbps: changes.bitrateKbps,
      keyframeSeconds: changes.keyframeSeconds
    })
    .where(and(eq(shows.organisationId, organisationId), eq(shows.id, showId)))
    .returning({
      id: shows.id,
      name: shows.name,
      width: shows.width,
      height: shows.height,
      fps: shows.fps,
      bitrateKbps: shows.bitrateKbps,
      keyframeSeconds: shows.keyframeSeconds,
      createdAt: shows.createdAt
    });
  if (!row) throw await unchanged(shows.id, showId);
  return row;
}

/** Delete the show, with its output and every hop: `forbidden` or `not_found` when the write reaches no row. */
export async function deleteShow(organisationId: string, showId: string) {
  const db = useDB();
  const deleted = await db
    .delete(shows)
    .where(and(eq(shows.organisationId, organisationId), eq(shows.id, showId)))
    .returning({ id: shows.id });
  if (deleted.length === 0) throw await unchanged(shows.id, showId);
}

/** The show's output, if it has one and it is visible. */
export async function getShowOutput(organisationId: string, showId: string) {
  const db = useDB();
  const [row] = await db
    .select({ showId: showOutputs.showId, deviceId: showOutputs.deviceId, createdAt: showOutputs.createdAt })
    .from(showOutputs)
    .where(and(eq(showOutputs.organisationId, organisationId), eq(showOutputs.showId, showId)));
  return row;
}

/**
 * Send the show out through the agent, in place of any other: the show and the agent must be the organisation's
 * (`invalid_reference`), and the agent the output of no other show (`conflict`).
 */
export async function setShowOutput(organisationId: string, showId: string, deviceId: string) {
  const db = useDB();
  const [row] = await db
    .insert(showOutputs)
    .values({ showId, organisationId, deviceId })
    .onConflictDoUpdate({ target: showOutputs.showId, set: { deviceId } })
    .returning({ showId: showOutputs.showId, deviceId: showOutputs.deviceId, createdAt: showOutputs.createdAt });
  return row!;
}

/** Stop sending the show out: `forbidden` or `not_found` when the write reaches no row. */
export async function deleteShowOutput(organisationId: string, showId: string) {
  const db = useDB();
  const deleted = await db
    .delete(showOutputs)
    .where(and(eq(showOutputs.organisationId, organisationId), eq(showOutputs.showId, showId)))
    .returning({ showId: showOutputs.showId });
  if (deleted.length === 0) throw await unchanged(showOutputs.showId, showId);
}

/** Forward the show to one of the organisation's channels (`invalid_reference` otherwise), once (`conflict`). */
export async function createShowForward(organisationId: string, showId: string, payload: NewShowForward) {
  const db = useDB();
  const [row] = await db
    .insert(showForwards)
    .values({ organisationId, showId, channelId: payload.channelId, enabled: payload.enabled })
    .returning({
      id: showForwards.id,
      channelId: showForwards.channelId,
      enabled: showForwards.enabled,
      createdAt: showForwards.createdAt
    });
  return row!;
}

/** Turn the forward on or off: `forbidden` or `not_found` when the write reaches no row. */
export async function updateShowForward(organisationId: string, showId: string, forwardId: string, enabled: boolean) {
  const db = useDB();
  const [row] = await db
    .update(showForwards)
    .set({ enabled })
    .where(
      and(
        eq(showForwards.organisationId, organisationId),
        eq(showForwards.showId, showId),
        eq(showForwards.id, forwardId)
      )
    )
    .returning({
      id: showForwards.id,
      channelId: showForwards.channelId,
      enabled: showForwards.enabled,
      createdAt: showForwards.createdAt
    });
  if (!row) throw await unchanged(showForwards.id, forwardId);
  return row;
}

/** Stop forwarding the show to the channel: `forbidden` or `not_found` when the write reaches no row. */
export async function deleteShowForward(organisationId: string, showId: string, forwardId: string) {
  const db = useDB();
  const deleted = await db
    .delete(showForwards)
    .where(
      and(
        eq(showForwards.organisationId, organisationId),
        eq(showForwards.showId, showId),
        eq(showForwards.id, forwardId)
      )
    )
    .returning({ id: showForwards.id });
  if (deleted.length === 0) throw await unchanged(showForwards.id, forwardId);
}

/** Preview the show at a gateway: `invalid_reference` for one that is not there, `conflict` for one it is at. */
export async function createShowPreview(organisationId: string, showId: string, gatewayId: string) {
  const db = useDB();
  const [row] = await db
    .insert(showPreviews)
    .values({ organisationId, showId, gatewayId })
    .returning({ id: showPreviews.id, gatewayId: showPreviews.gatewayId, createdAt: showPreviews.createdAt });
  await checkGateway(organisationId, gatewayId);
  return row!;
}

/** Remove the preview: `forbidden` or `not_found` when the write reaches no row. */
export async function deleteShowPreview(organisationId: string, showId: string, previewId: string) {
  const db = useDB();
  const deleted = await db
    .delete(showPreviews)
    .where(
      and(
        eq(showPreviews.organisationId, organisationId),
        eq(showPreviews.showId, showId),
        eq(showPreviews.id, previewId)
      )
    )
    .returning({ id: showPreviews.id });
  if (deleted.length === 0) throw await unchanged(showPreviews.id, previewId);
}

/** Record the show, one recorder of each kind (`conflict`). */
export async function createShowRecorder(organisationId: string, showId: string, payload: NewShowRecorder) {
  const db = useDB();
  const [row] = await db
    .insert(showRecorders)
    .values({ organisationId, showId, kind: payload.kind, params: payload.params })
    .returning({
      id: showRecorders.id,
      kind: showRecorders.kind,
      params: showRecorders.params,
      createdAt: showRecorders.createdAt
    });
  return row!;
}

/** Change the recorder: `forbidden` or `not_found` when the write reaches no row. */
export async function updateShowRecorder(
  organisationId: string,
  showId: string,
  recorderId: string,
  changes: ShowRecorderChanges
) {
  const db = useDB();
  const [row] = await db
    .update(showRecorders)
    .set({ kind: changes.kind, params: changes.params })
    .where(
      and(
        eq(showRecorders.organisationId, organisationId),
        eq(showRecorders.showId, showId),
        eq(showRecorders.id, recorderId)
      )
    )
    .returning({
      id: showRecorders.id,
      kind: showRecorders.kind,
      params: showRecorders.params,
      createdAt: showRecorders.createdAt
    });
  if (!row) throw await unchanged(showRecorders.id, recorderId);
  return row;
}

/** Remove the recorder: `forbidden` or `not_found` when the write reaches no row. */
export async function deleteShowRecorder(organisationId: string, showId: string, recorderId: string) {
  const db = useDB();
  const deleted = await db
    .delete(showRecorders)
    .where(
      and(
        eq(showRecorders.organisationId, organisationId),
        eq(showRecorders.showId, showId),
        eq(showRecorders.id, recorderId)
      )
    )
    .returning({ id: showRecorders.id });
  if (deleted.length === 0) throw await unchanged(showRecorders.id, recorderId);
}

/** The show the device is the output of, if any. Trusted code: a device cannot read the topology. */
export async function selectOutputShow(deviceId: string) {
  const db = useDB({ trusted: true });
  const [row] = await db
    .select({ showId: showOutputs.showId, organisationId: showOutputs.organisationId })
    .from(showOutputs)
    .where(eq(showOutputs.deviceId, deviceId));
  return row;
}

/**
 * What the device's show sends out, for planning its configuration: the show's encoding, its enabled forwards, its
 * previews and its recorders. Trusted code: IDs and settings only.
 */
export async function selectOutputPlan(showId: string) {
  const db = useDB({ trusted: true });
  return db.query.shows.findFirst({
    columns: { width: true, height: true, fps: true, bitrateKbps: true, keyframeSeconds: true },
    with: {
      forwards: {
        columns: { id: true, channelId: true },
        with: { channel: { columns: { kind: true } } },
        where: { enabled: true },
        orderBy: { id: 'asc' }
      },
      previews: { columns: { id: true, gatewayId: true }, orderBy: { id: 'asc' } },
      recorders: { columns: { id: true, kind: true, params: true }, orderBy: { id: 'asc' } }
    },
    where: { id: showId }
  });
}

/**
 * Grant `channelBroadcaster` at the organisation to the devices its shows go out through, and revoke it from any other
 * device holding it: after an output is set or removed, or a show deleted. Trusted code, so it can grant; run once the
 * request session has made the change, which row-level security allowed only an administrator to.
 */
export async function syncBroadcasters(organisationId: string) {
  const db = useDB({ trusted: true });
  const access = useAccess();
  const scope = organisationScope(organisationId);
  const outputs = await db
    .select({ deviceId: showOutputs.deviceId })
    .from(showOutputs)
    .where(eq(showOutputs.organisationId, organisationId));
  const wanted = new Set(outputs.map(output => output.deviceId));
  const held = await access.grantsQuery({ role: channelBroadcaster, scope });
  for (const grant of held) {
    if (grant.principalKind !== 'device' || wanted.has(grant.principalId)) continue;
    await access.at(scope).revoke({ principal: device(grant.principalId), role: channelBroadcaster });
  }
  for (const deviceId of wanted) {
    await access.at(scope).grant({ principal: device(deviceId), role: channelBroadcaster });
  }
}
