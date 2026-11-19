import { device } from '@conservationtv/umbrella';
import { and, eq } from 'drizzle-orm';
import { channelBroadcaster } from '../db/roles.ts';
import {
  outputControls,
  outputDevices,
  outputForwards,
  outputPreviews,
  outputRecorders,
  outputs
} from '../db/schema.ts';
import { useAccess, useDB } from '../db/transaction.ts';
import { checkGateway } from '../topology/exposures.ts';
import type { OutputControl, OutputRecorderKind } from '../topology/output-recorder-kinds.ts';
import type { Settings } from '../topology/settings.ts';
import { unchanged } from '../topology/transaction.ts';
import { organisationScope } from './organisations.ts';

// An organisation's outputs (src/db/schemas/outputs.ts), each with its device, forwards, previews and recorders, in the
// principal's request session: members read them, administrators manage them. The database's composite foreign keys
// keep every reference inside one organisation; a preview's gateway, which may be built in, is checked after each
// write (src/topology/exposures.ts), as an exposure's is. Which output a device runs, and what it plans, is read by
// trusted code, as a device principal cannot read the topology. Each output's device is granted `channelBroadcaster`,
// to read the stream keys of the channels it forwards to, for as long as it is one, and no longer (`syncBroadcasters`).

/** An output's programme encoding: what OBS encodes it as. */
export interface OutputEncoding {
  width: number;
  height: number;
  fps: number;
  bitrateKbps: number;
  keyframeSeconds: number;
}

export interface NewOutput extends Partial<OutputEncoding> {
  name: string;
  control?: OutputControl;
  showId?: string | null;
}

export interface OutputChanges extends Partial<OutputEncoding> {
  name?: string;
  control?: OutputControl;
  showId?: string | null;
}

export interface NewOutputForward {
  channelId: string;
  enabled: boolean;
}

export interface NewOutputRecorder {
  kind: OutputRecorderKind;
  params: Settings;
}

export interface OutputRecorderChanges {
  kind?: OutputRecorderKind;
  params?: Settings;
}

/** An output, as its agent reports about it. */
export interface ReportingOutput {
  outputId: string;
  organisationId: string;
}

/** What OBS's agent says it can be driven by from outside (`organisations.outputs.control.report`). */
export interface ReportedControl {
  websocketPort: number;
  websocketPassword: string;
  sceneCollection: string;
  inputUrl: string;
}

/** An output's own columns, as every read and write returns them. */
const OUTPUT_COLUMNS = {
  id: true,
  name: true,
  control: true,
  showId: true,
  width: true,
  height: true,
  fps: true,
  bitrateKbps: true,
  keyframeSeconds: true,
  createdAt: true
} as const;

/** An output's hops, as its reads return them. */
const OUTPUT_HOPS = {
  device: { columns: { deviceId: true, createdAt: true } },
  forwards: { columns: { id: true, channelId: true, enabled: true, createdAt: true }, orderBy: { id: 'asc' } },
  previews: { columns: { id: true, gatewayId: true, createdAt: true }, orderBy: { id: 'asc' } },
  recorders: { columns: { id: true, kind: true, params: true, createdAt: true }, orderBy: { id: 'asc' } }
} as const;

/** An output's own columns, as a write returns them. */
const OUTPUT_RETURNING = {
  id: outputs.id,
  name: outputs.name,
  control: outputs.control,
  showId: outputs.showId,
  width: outputs.width,
  height: outputs.height,
  fps: outputs.fps,
  bitrateKbps: outputs.bitrateKbps,
  keyframeSeconds: outputs.keyframeSeconds,
  createdAt: outputs.createdAt
};

/** The organisation's outputs, oldest first, each with its device (or null) and its forwards, previews and recorders. */
export function listOutputs(organisationId: string) {
  const db = useDB();
  return db.query.outputs.findMany({
    columns: OUTPUT_COLUMNS,
    with: OUTPUT_HOPS,
    where: { organisationId },
    orderBy: { id: 'asc' }
  });
}

/** The output, with its device and its forwards, previews and recorders, if it is visible. */
export function getOutputWithTopology(organisationId: string, outputId: string) {
  const db = useDB();
  return db.query.outputs.findFirst({
    columns: OUTPUT_COLUMNS,
    with: OUTPUT_HOPS,
    where: { organisationId, id: outputId }
  });
}

/** Whether the output is visible: what its hops' writes check first, so an output that is not there is `not_found`. */
export async function outputVisible(organisationId: string, outputId: string) {
  const db = useDB();
  const [row] = await db
    .select({ id: outputs.id })
    .from(outputs)
    .where(and(eq(outputs.organisationId, organisationId), eq(outputs.id, outputId)));
  return row !== undefined;
}

/**
 * Create an output, its encoding the defaults where not given: following the show given, under `show` control (the
 * default), and none when `external`. The show must be the organisation's (`invalid_reference`).
 */
export async function createOutput(organisationId: string, payload: NewOutput) {
  const db = useDB();
  const [row] = await db
    .insert(outputs)
    .values({ organisationId, ...payload, showId: payload.control === 'external' ? null : payload.showId })
    .returning(OUTPUT_RETURNING);
  return row!;
}

/**
 * Rename the output, change its encoding, or who drives it: `external` leaves the show it followed; a show given under
 * `external` control is a `conflict`. `forbidden` or `not_found` when the write reaches no row.
 */
export async function updateOutput(organisationId: string, outputId: string, changes: OutputChanges) {
  const db = useDB();
  const showId = changes.control === 'external' && changes.showId === undefined ? null : changes.showId;
  const [row] = await db
    .update(outputs)
    .set({
      name: changes.name,
      control: changes.control,
      showId,
      width: changes.width,
      height: changes.height,
      fps: changes.fps,
      bitrateKbps: changes.bitrateKbps,
      keyframeSeconds: changes.keyframeSeconds
    })
    .where(and(eq(outputs.organisationId, organisationId), eq(outputs.id, outputId)))
    .returning(OUTPUT_RETURNING);
  if (!row) throw await unchanged(outputs.id, outputId);
  return row;
}

/** Delete the output, with its device and every hop: `forbidden` or `not_found` when the write reaches no row. */
export async function deleteOutput(organisationId: string, outputId: string) {
  const db = useDB();
  const deleted = await db
    .delete(outputs)
    .where(and(eq(outputs.organisationId, organisationId), eq(outputs.id, outputId)))
    .returning({ id: outputs.id });
  if (deleted.length === 0) throw await unchanged(outputs.id, outputId);
}

/** The output's device, if it has one and it is visible. */
export async function getOutputDevice(organisationId: string, outputId: string) {
  const db = useDB();
  const [row] = await db
    .select({ outputId: outputDevices.outputId, deviceId: outputDevices.deviceId, createdAt: outputDevices.createdAt })
    .from(outputDevices)
    .where(and(eq(outputDevices.organisationId, organisationId), eq(outputDevices.outputId, outputId)));
  return row;
}

/**
 * Run the output on the agent, in place of any other: the output and the agent must be the organisation's
 * (`invalid_reference`), and the agent the device of no other output (`conflict`).
 */
export async function setOutputDevice(organisationId: string, outputId: string, deviceId: string) {
  const db = useDB();
  const [row] = await db
    .insert(outputDevices)
    .values({ outputId, organisationId, deviceId })
    .onConflictDoUpdate({ target: outputDevices.outputId, set: { deviceId } })
    .returning({
      outputId: outputDevices.outputId,
      deviceId: outputDevices.deviceId,
      createdAt: outputDevices.createdAt
    });
  return row!;
}

/** Stop running the output anywhere: `forbidden` or `not_found` when the write reaches no row. */
export async function deleteOutputDevice(organisationId: string, outputId: string) {
  const db = useDB();
  const deleted = await db
    .delete(outputDevices)
    .where(and(eq(outputDevices.organisationId, organisationId), eq(outputDevices.outputId, outputId)))
    .returning({ outputId: outputDevices.outputId });
  if (deleted.length === 0) throw await unchanged(outputDevices.outputId, outputId);
}

/** Forward the output to one of the organisation's channels (`invalid_reference` otherwise), once (`conflict`). */
export async function createOutputForward(organisationId: string, outputId: string, payload: NewOutputForward) {
  const db = useDB();
  const [row] = await db
    .insert(outputForwards)
    .values({ organisationId, outputId, channelId: payload.channelId, enabled: payload.enabled })
    .returning({
      id: outputForwards.id,
      channelId: outputForwards.channelId,
      enabled: outputForwards.enabled,
      createdAt: outputForwards.createdAt
    });
  return row!;
}

/** Turn the forward on or off: `forbidden` or `not_found` when the write reaches no row. */
export async function updateOutputForward(
  organisationId: string,
  outputId: string,
  forwardId: string,
  enabled: boolean
) {
  const db = useDB();
  const [row] = await db
    .update(outputForwards)
    .set({ enabled })
    .where(
      and(
        eq(outputForwards.organisationId, organisationId),
        eq(outputForwards.outputId, outputId),
        eq(outputForwards.id, forwardId)
      )
    )
    .returning({
      id: outputForwards.id,
      channelId: outputForwards.channelId,
      enabled: outputForwards.enabled,
      createdAt: outputForwards.createdAt
    });
  if (!row) throw await unchanged(outputForwards.id, forwardId);
  return row;
}

/** Stop forwarding the output to the channel: `forbidden` or `not_found` when the write reaches no row. */
export async function deleteOutputForward(organisationId: string, outputId: string, forwardId: string) {
  const db = useDB();
  const deleted = await db
    .delete(outputForwards)
    .where(
      and(
        eq(outputForwards.organisationId, organisationId),
        eq(outputForwards.outputId, outputId),
        eq(outputForwards.id, forwardId)
      )
    )
    .returning({ id: outputForwards.id });
  if (deleted.length === 0) throw await unchanged(outputForwards.id, forwardId);
}

/** Preview the output at a gateway: `invalid_reference` for one that is not there, `conflict` for one it is at. */
export async function createOutputPreview(organisationId: string, outputId: string, gatewayId: string) {
  const db = useDB();
  const [row] = await db
    .insert(outputPreviews)
    .values({ organisationId, outputId, gatewayId })
    .returning({ id: outputPreviews.id, gatewayId: outputPreviews.gatewayId, createdAt: outputPreviews.createdAt });
  await checkGateway(organisationId, gatewayId);
  return row!;
}

/** Remove the preview: `forbidden` or `not_found` when the write reaches no row. */
export async function deleteOutputPreview(organisationId: string, outputId: string, previewId: string) {
  const db = useDB();
  const deleted = await db
    .delete(outputPreviews)
    .where(
      and(
        eq(outputPreviews.organisationId, organisationId),
        eq(outputPreviews.outputId, outputId),
        eq(outputPreviews.id, previewId)
      )
    )
    .returning({ id: outputPreviews.id });
  if (deleted.length === 0) throw await unchanged(outputPreviews.id, previewId);
}

/** Record the output, one recorder of each kind (`conflict`). */
export async function createOutputRecorder(organisationId: string, outputId: string, payload: NewOutputRecorder) {
  const db = useDB();
  const [row] = await db
    .insert(outputRecorders)
    .values({ organisationId, outputId, kind: payload.kind, params: payload.params })
    .returning({
      id: outputRecorders.id,
      kind: outputRecorders.kind,
      params: outputRecorders.params,
      createdAt: outputRecorders.createdAt
    });
  return row!;
}

/** Change the recorder: `forbidden` or `not_found` when the write reaches no row. */
export async function updateOutputRecorder(
  organisationId: string,
  outputId: string,
  recorderId: string,
  changes: OutputRecorderChanges
) {
  const db = useDB();
  const [row] = await db
    .update(outputRecorders)
    .set({ kind: changes.kind, params: changes.params })
    .where(
      and(
        eq(outputRecorders.organisationId, organisationId),
        eq(outputRecorders.outputId, outputId),
        eq(outputRecorders.id, recorderId)
      )
    )
    .returning({
      id: outputRecorders.id,
      kind: outputRecorders.kind,
      params: outputRecorders.params,
      createdAt: outputRecorders.createdAt
    });
  if (!row) throw await unchanged(outputRecorders.id, recorderId);
  return row;
}

/** Remove the recorder: `forbidden` or `not_found` when the write reaches no row. */
export async function deleteOutputRecorder(organisationId: string, outputId: string, recorderId: string) {
  const db = useDB();
  const deleted = await db
    .delete(outputRecorders)
    .where(
      and(
        eq(outputRecorders.organisationId, organisationId),
        eq(outputRecorders.outputId, outputId),
        eq(outputRecorders.id, recorderId)
      )
    )
    .returning({ id: outputRecorders.id });
  if (deleted.length === 0) throw await unchanged(outputRecorders.id, recorderId);
}

/**
 * How to drive the output's OBS from outside, as the agent it runs on now last reported it: none before that agent
 * has, or for anyone but an administrator.
 */
export async function getOutputControl(organisationId: string, outputId: string) {
  const db = useDB();
  const [row] = await db
    .select({
      deviceId: outputControls.deviceId,
      websocketPort: outputControls.websocketPort,
      websocketPassword: outputControls.websocketPassword,
      sceneCollection: outputControls.sceneCollection,
      inputUrl: outputControls.inputUrl,
      reportedAt: outputControls.reportedAt
    })
    .from(outputControls)
    .innerJoin(
      outputDevices,
      and(eq(outputDevices.outputId, outputControls.outputId), eq(outputDevices.deviceId, outputControls.deviceId))
    )
    .where(and(eq(outputControls.organisationId, organisationId), eq(outputControls.outputId, outputId)));
  return row;
}

/** The output the device runs, if any: who drives it, and the show it follows. Trusted code: a device cannot read the topology. */
export async function selectDeviceOutput(deviceId: string) {
  const db = useDB({ trusted: true });
  const [row] = await db
    .select({
      outputId: outputs.id,
      organisationId: outputs.organisationId,
      control: outputs.control,
      showId: outputs.showId
    })
    .from(outputDevices)
    .innerJoin(outputs, eq(outputs.id, outputDevices.outputId))
    .where(eq(outputDevices.deviceId, deviceId));
  return row;
}

/**
 * What the output sends out, for planning its device's configuration: its encoding, its enabled forwards, its previews
 * and its recorders. Trusted code: IDs and settings only.
 */
export async function selectOutputPlan(outputId: string) {
  const db = useDB({ trusted: true });
  return db.query.outputs.findFirst({
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
    where: { id: outputId }
  });
}

/**
 * Keep what the device reports of how to drive its output's OBS from outside. Trusted code, for the device the output
 * runs on (`selectDeviceOutput`): no principal writes these.
 */
export async function reportOutputControl(output: ReportingOutput, deviceId: string, report: ReportedControl) {
  const db = useDB({ trusted: true });
  const reportedAt = new Date();
  await db
    .insert(outputControls)
    .values({ ...output, deviceId, ...report, reportedAt })
    .onConflictDoUpdate({ target: outputControls.outputId, set: { deviceId, ...report, reportedAt } });
}

/**
 * Grant `channelBroadcaster` at the organisation to the devices its outputs run on, and revoke it from any other device
 * holding it: after a device is set or removed, or an output deleted. Trusted code, so it can grant; run once the
 * request session has made the change, which row-level security allowed only an administrator to.
 */
export async function syncBroadcasters(organisationId: string) {
  const db = useDB({ trusted: true });
  const access = useAccess();
  const scope = organisationScope(organisationId);
  const devices = await db
    .select({ deviceId: outputDevices.deviceId })
    .from(outputDevices)
    .where(eq(outputDevices.organisationId, organisationId));
  const wanted = new Set(devices.map(row => row.deviceId));
  const held = await access.grantsQuery({ role: channelBroadcaster, scope });
  for (const grant of held) {
    if (grant.principalKind !== 'device' || wanted.has(grant.principalId)) continue;
    await access.at(scope).revoke({ principal: device(grant.principalId), role: channelBroadcaster });
  }
  for (const deviceId of wanted) {
    await access.at(scope).grant({ principal: device(deviceId), role: channelBroadcaster });
  }
}
