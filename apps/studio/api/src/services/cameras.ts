import { and, eq, ne } from 'drizzle-orm';
import { chatName, type CameraCredentials, type CameraPosition, type CameraSettings } from '@conservationtv/cameras';
import type { CameraState } from '../cameras/states.ts';
import { user } from '@conservationtv/umbrella';
import { cameraPresets, cameras, devices } from '../db/schema.ts';
import { useAccess, useDB } from '../db/transaction.ts';
import { organisationScope } from './organisations.ts';
import { ApiFailure } from '../errors.ts';
import { unchanged } from '../topology/transaction.ts';

// An organisation's cameras (src/db/schemas/cameras.ts): each a device, sharing its ID, whose `settings` name the
// driver that reads it. The camera's row is created and removed beside its device (src/services/devices.ts), in the
// same transaction. Its credentials are written, but never read back here: request sessions cannot select them.
//
// A camera is called by its device's name in chat, or by any of its `aliases` (src/services/chat-commands.ts), so an
// alias may not be what another camera is already called. Its presets (`camera_preset`) are positions saved by name.

export interface NewCamera {
  settings: CameraSettings;
  credentials?: CameraCredentials;
  state?: CameraState;
  aliases?: string[];
}

export interface CameraChanges {
  settings?: CameraSettings;
  /** `null` clears them. */
  credentials?: CameraCredentials | null;
  state?: CameraState;
  aliases?: string[];
}

export interface NewCameraPreset {
  name: string;
  position: CameraPosition;
}

export interface CameraPresetChanges {
  name?: string;
  position?: CameraPosition;
}

/**
 * Refuses the user unless they may `edit` the organisation's cameras, which is who may control them: `not_found` if
 * they cannot see them, `forbidden` if they may not. The decision row-level security would make, from the cameras
 * table's own roles, for trusted code that signs with an agent's identity.
 */
export async function requireCameraPermission(organisationId: string, userId: string, action: 'edit') {
  const access = useAccess();
  const scope = organisationScope(organisationId);
  const decision = await access.inspect({ principal: user(userId), resource: cameras, scope });
  if (!decision.permissions.read?.allowed) throw new ApiFailure('not_found');
  if (!decision.permissions[action]?.allowed) throw new ApiFailure('forbidden');
}

/** The organisation's cameras, oldest first, each with its device, its aliases and its presets. */
export function listCameras(organisationId: string) {
  const db = useDB();
  return db.query.cameras.findMany({
    columns: { id: true, settings: true, state: true, aliases: true },
    with: {
      device: {
        columns: { kind: true, name: true, networkId: true, publicKey: true, publicId: true, createdAt: true }
      },
      presets: {
        columns: { id: true, name: true, position: true, thumbnail: true, createdAt: true },
        orderBy: { id: 'asc' }
      }
    },
    where: { organisationId },
    orderBy: { id: 'asc' }
  });
}

/** The camera, with its device, its aliases and its presets, if it is visible. */
export function getCamera(organisationId: string, cameraId: string) {
  const db = useDB();
  return db.query.cameras.findFirst({
    columns: { id: true, settings: true, state: true, aliases: true },
    with: {
      device: {
        columns: { kind: true, name: true, networkId: true, publicKey: true, publicId: true, createdAt: true }
      },
      presets: {
        columns: { id: true, name: true, position: true, thumbnail: true, createdAt: true },
        orderBy: { id: 'asc' }
      }
    },
    where: { organisationId, id: cameraId }
  });
}

/** Make the device a camera. */
export async function createCamera(organisationId: string, cameraId: string, payload: NewCamera) {
  const db = useDB();
  await db.insert(cameras).values({
    id: cameraId,
    organisationId,
    settings: payload.settings,
    credentials: payload.credentials,
    state: payload.state,
    aliases: payload.aliases
  });
}

/** Replace the camera's settings, its credentials, or its state: `forbidden` or `not_found` when the write reaches no row. */
export async function updateCamera(organisationId: string, cameraId: string, changes: CameraChanges) {
  const db = useDB();
  const updated = await db
    .update(cameras)
    .set({
      settings: changes.settings,
      credentials: changes.credentials,
      state: changes.state,
      aliases: changes.aliases
    })
    .where(and(eq(cameras.organisationId, organisationId), eq(cameras.id, cameraId)))
    .returning({ id: cameras.id });
  if (updated.length === 0) throw await unchanged(cameras.id, cameraId);
}

/** Delete the camera's row, before its device: `not_found` if there is none. */
export async function deleteCamera(organisationId: string, cameraId: string) {
  const db = useDB();
  const deleted = await db
    .delete(cameras)
    .where(and(eq(cameras.organisationId, organisationId), eq(cameras.id, cameraId)))
    .returning({ id: cameras.id });
  if (deleted.length === 0) throw new ApiFailure('not_found');
}

/**
 * Refuses aliases another camera of the organisation is already called by, as chat compares names
 * (`chatName`): `conflict`. `cameraId` is the camera they are for, left out of the comparison; none for a new camera.
 */
export async function requireFreeAliases(organisationId: string, cameraId: string | undefined, aliases: string[]) {
  if (aliases.length === 0) return;
  const db = useDB();
  const others = await db
    .select({ name: devices.name, aliases: cameras.aliases })
    .from(cameras)
    .innerJoin(devices, eq(devices.id, cameras.id))
    .where(and(eq(cameras.organisationId, organisationId), cameraId === undefined ? undefined : ne(cameras.id, cameraId)));
  const taken = new Set(others.flatMap(other => [other.name, ...other.aliases]).map(chatName));
  if (aliases.some(alias => taken.has(chatName(alias)))) throw new ApiFailure('conflict');
}

/** Save a position of the camera's under a name: `conflict` if it has one of that name. */
export async function createCameraPreset(organisationId: string, cameraId: string, payload: NewCameraPreset) {
  const db = useDB();
  const [row] = await db
    .insert(cameraPresets)
    .values({ organisationId, cameraId, name: payload.name, position: payload.position })
    .returning({
      id: cameraPresets.id,
      cameraId: cameraPresets.cameraId,
      name: cameraPresets.name,
      position: cameraPresets.position,
      thumbnail: cameraPresets.thumbnail,
      createdAt: cameraPresets.createdAt
    });
  return row!;
}

/** Rename the preset, or save another position as it: `forbidden` or `not_found` when the write reaches no row. */
export async function updateCameraPreset(
  organisationId: string,
  cameraId: string,
  presetId: string,
  changes: CameraPresetChanges
) {
  const db = useDB();
  const [row] = await db
    .update(cameraPresets)
    .set({ name: changes.name, position: changes.position })
    .where(
      and(
        eq(cameraPresets.organisationId, organisationId),
        eq(cameraPresets.cameraId, cameraId),
        eq(cameraPresets.id, presetId)
      )
    )
    .returning({
      id: cameraPresets.id,
      cameraId: cameraPresets.cameraId,
      name: cameraPresets.name,
      position: cameraPresets.position,
      thumbnail: cameraPresets.thumbnail,
      createdAt: cameraPresets.createdAt
    });
  if (!row) throw await unchanged(cameraPresets.id, presetId);
  return row;
}

/** Where a preset's thumbnail is kept in the studio's media: under its organisation and preset, by its token. */
export function presetThumbnailKey(organisationId: string, presetId: string, token: string) {
  return `organisations/${organisationId}/camera-presets/${presetId}/${token}`;
}

/** The token of the preset's thumbnail, if the preset is visible: null when it has none. */
export async function getPresetThumbnail(organisationId: string, cameraId: string, presetId: string) {
  const db = useDB();
  const [row] = await db
    .select({ thumbnail: cameraPresets.thumbnail })
    .from(cameraPresets)
    .where(
      and(
        eq(cameraPresets.organisationId, organisationId),
        eq(cameraPresets.cameraId, cameraId),
        eq(cameraPresets.id, presetId)
      )
    );
  return row;
}

/**
 * Point the preset at another thumbnail, or none: `forbidden` or `not_found` when the write reaches no row. Returns
 * the preset as it is now.
 */
export async function setPresetThumbnail(
  organisationId: string,
  cameraId: string,
  presetId: string,
  token: string | null
) {
  const db = useDB();
  const [row] = await db
    .update(cameraPresets)
    .set({ thumbnail: token })
    .where(
      and(
        eq(cameraPresets.organisationId, organisationId),
        eq(cameraPresets.cameraId, cameraId),
        eq(cameraPresets.id, presetId)
      )
    )
    .returning({
      id: cameraPresets.id,
      cameraId: cameraPresets.cameraId,
      name: cameraPresets.name,
      position: cameraPresets.position,
      thumbnail: cameraPresets.thumbnail,
      createdAt: cameraPresets.createdAt
    });
  if (!row) throw await unchanged(cameraPresets.id, presetId);
  return row;
}

/** Forget the preset, returning what it was so its thumbnail can go too: `forbidden` or `not_found` when the write reaches no row. */
export async function deleteCameraPreset(organisationId: string, cameraId: string, presetId: string) {
  const db = useDB();
  const deleted = await db
    .delete(cameraPresets)
    .where(
      and(
        eq(cameraPresets.organisationId, organisationId),
        eq(cameraPresets.cameraId, cameraId),
        eq(cameraPresets.id, presetId)
      )
    )
    .returning({ id: cameraPresets.id, thumbnail: cameraPresets.thumbnail });
  if (deleted.length === 0) throw await unchanged(cameraPresets.id, presetId);
  return deleted[0]!;
}
