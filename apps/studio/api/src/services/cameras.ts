import { and, eq } from 'drizzle-orm';
import type { CameraCredentials, CameraSettings } from '../cameras/drivers.ts';
import { cameras } from '../db/schema.ts';
import { useDB } from '../db/transaction.ts';
import { ApiFailure } from '../errors.ts';
import { unchanged } from '../topology/transaction.ts';

// An organisation's cameras (src/db/schemas/cameras.ts): each a device, sharing its ID, whose `settings` name the
// driver that reads it. The camera's row is created and removed beside its device (src/services/devices.ts), in the
// same transaction. Its credentials are written, but never read back here: request sessions cannot select them.

export interface NewCamera {
  settings: CameraSettings;
  credentials?: CameraCredentials;
}

export interface CameraChanges {
  settings?: CameraSettings;
  /** `null` clears them. */
  credentials?: CameraCredentials | null;
}

/** The organisation's cameras, oldest first, each with its device. */
export function listCameras(organisationId: string) {
  const db = useDB();
  return db.query.cameras.findMany({
    columns: { id: true, settings: true },
    with: {
      device: {
        columns: { kind: true, name: true, networkId: true, publicKey: true, publicId: true, createdAt: true }
      }
    },
    where: { organisationId },
    orderBy: { id: 'asc' }
  });
}

/** The camera, with its device, if it is visible. */
export function getCamera(organisationId: string, cameraId: string) {
  const db = useDB();
  return db.query.cameras.findFirst({
    columns: { id: true, settings: true },
    with: {
      device: {
        columns: { kind: true, name: true, networkId: true, publicKey: true, publicId: true, createdAt: true }
      }
    },
    where: { organisationId, id: cameraId }
  });
}

/** Make the device a camera. */
export async function createCamera(organisationId: string, cameraId: string, payload: NewCamera) {
  const db = useDB();
  await db
    .insert(cameras)
    .values({ id: cameraId, organisationId, settings: payload.settings, credentials: payload.credentials });
}

/** Replace the camera's settings, or its credentials: `forbidden` or `not_found` when the write reaches no row. */
export async function updateCamera(organisationId: string, cameraId: string, changes: CameraChanges) {
  const db = useDB();
  const updated = await db
    .update(cameras)
    .set({ settings: changes.settings, credentials: changes.credentials })
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
