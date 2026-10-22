import { device, user } from '@conservationtv/umbrella';
import { and, eq, sql } from 'drizzle-orm';
import { organisationDevice } from '../db/roles.ts';
import { devices } from '../db/schema.ts';
import { useAccess, useDB } from '../db/transaction.ts';
import { ApiFailure } from '../errors.ts';
import type { DeviceKind } from '../topology/device-kinds.ts';
import { deviceIdentity } from '../topology/identity.ts';
import { unchanged } from '../topology/transaction.ts';
import { organisationScope } from './organisations.ts';

// An organisation's devices. Reads and edits run in whichever transaction the caller is in, so in a request session
// row-level security decides whose. Every device is a principal of its organisation, `device(<id>)`, holding
// `organisationDevice` there, so it reads the organisation's devices for iroh allowlists: creating a device grants it
// and removing one revokes it, so a device never exists without it. Request sessions cannot write grants, or read
// private keys, so those are trusted code, after `requireDevicePermission` makes the decision row-level security would.

/** What can be done to an organisation's devices, as the devices table's roles name it. */
export type DeviceAction = 'create' | 'edit' | 'remove';

export interface DeviceFilter {
  /** Only devices of this kind. */
  kind?: DeviceKind;
}

export interface NewDevice {
  kind: DeviceKind;
  name: string;
  networkId: string | null;
}

export interface DeviceChanges {
  name?: string;
  networkId?: string | null;
}

/**
 * Refuses the user unless they may `action` the organisation's devices: `not_found` if they cannot see them,
 * `forbidden` if they may not. The decision row-level security would make, from the devices table's own roles.
 */
export async function requireDevicePermission(organisationId: string, userId: string, action: DeviceAction) {
  const access = useAccess();
  const scope = organisationScope(organisationId);
  const decision = await access.inspect({ principal: user(userId), resource: devices, scope });
  // Invisible devices are not found; visible ones the user may not change are forbidden.
  if (!decision.permissions.read?.allowed) throw new ApiFailure('not_found');
  if (!decision.permissions[action]?.allowed) throw new ApiFailure('forbidden');
}

/** The iroh endpoint ID of each of the organisation's devices, oldest first, for an allowlist. */
export async function listDevicePublicIds(organisationId: string) {
  const db = useDB();
  const [row] = await db
    .select({ publicIds: sql<string[]>`coalesce(array_agg(${devices.publicId} order by ${devices.id}), '{}')` })
    .from(devices)
    .where(eq(devices.organisationId, organisationId));
  return row!;
}

/** The organisation's devices, oldest first. */
export function listDevices(organisationId: string, filter: DeviceFilter) {
  const db = useDB();
  return db
    .select({
      id: devices.id,
      kind: devices.kind,
      name: devices.name,
      networkId: devices.networkId,
      publicKey: devices.publicKey,
      publicId: devices.publicId,
      createdAt: devices.createdAt
    })
    .from(devices)
    .where(
      and(
        eq(devices.organisationId, organisationId),
        filter.kind === undefined ? undefined : eq(devices.kind, filter.kind)
      )
    )
    .orderBy(devices.id);
}

/** The device, if it is visible. */
export async function getDevice(organisationId: string, deviceId: string) {
  const db = useDB();
  const [row] = await db
    .select({
      id: devices.id,
      kind: devices.kind,
      name: devices.name,
      networkId: devices.networkId,
      publicKey: devices.publicKey,
      publicId: devices.publicId,
      createdAt: devices.createdAt
    })
    .from(devices)
    .where(and(eq(devices.organisationId, organisationId), eq(devices.id, deviceId)));
  return row;
}

/** The device's key pair, private key included, if it exists: trusted code, once the user may edit its devices. */
export async function getDeviceKeyPair(organisationId: string, deviceId: string) {
  const db = useDB({ trusted: true });
  const [row] = await db
    .select({ publicKey: devices.publicKey, publicId: devices.publicId, privateKey: devices.privateKey })
    .from(devices)
    .where(and(eq(devices.organisationId, organisationId), eq(devices.id, deviceId)));
  return row;
}

/** Create a device with a new identity, as a principal of its organisation. Trusted code, so it can grant. */
export async function createDevice(organisationId: string, payload: NewDevice) {
  const db = useDB({ trusted: true });
  const access = useAccess();
  const identity = await deviceIdentity();
  const [created] = await db
    .insert(devices)
    .values({ ...identity, organisationId, kind: payload.kind, name: payload.name, networkId: payload.networkId })
    .returning({ id: devices.id });
  await access
    .at(organisationScope(organisationId))
    .grant({ principal: device(created!.id), role: organisationDevice });
  return created!;
}

/** Rename or move the device: `forbidden` or `not_found` when the write reaches no row. */
export async function updateDevice(organisationId: string, deviceId: string, changes: DeviceChanges) {
  const db = useDB();
  const [row] = await db
    .update(devices)
    .set({ name: changes.name, networkId: changes.networkId })
    .where(and(eq(devices.organisationId, organisationId), eq(devices.id, deviceId)))
    .returning({
      id: devices.id,
      kind: devices.kind,
      name: devices.name,
      networkId: devices.networkId,
      publicKey: devices.publicKey,
      publicId: devices.publicId,
      createdAt: devices.createdAt
    });
  if (!row) throw await unchanged(devices.id, deviceId);
  return row;
}

/** Delete the device, once its kind's row is gone, and every grant it holds. Trusted code, so it can revoke. */
export async function deleteDevice(organisationId: string, deviceId: string) {
  const db = useDB({ trusted: true });
  const access = useAccess();
  await db.delete(devices).where(and(eq(devices.organisationId, organisationId), eq(devices.id, deviceId)));
  await access.at(organisationScope(organisationId)).revoke({ principal: device(deviceId) });
}
