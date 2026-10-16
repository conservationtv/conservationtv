import { device, type Access } from '@conservationtv/umbrella';
import { organisationDevice } from '../db/roles.ts';
import { organisationScope } from '../organisations/membership.ts';

// Every device is a principal of its organisation, `device(<id>)`, holding `organisationDevice` there: it reads the
// organisation's devices, for iroh allowlists. Grants are made and revoked by the code that creates and deletes
// devices, in trusted code. Granting is idempotent, so whatever authenticates a device in future should ensure the
// grant again, healing a device whose grant was not made; a grant left by a device that no longer exists is harmless,
// since nothing can authenticate as it.

/** Make the device a principal of its organisation. */
export function grantDevice(access: Access, organisationId: string, deviceId: string) {
  return access.at(organisationScope(organisationId)).grant({ principal: device(deviceId), role: organisationDevice });
}

/** Revoke every grant the device holds in its organisation. */
export function revokeDevice(access: Access, organisationId: string, deviceId: string) {
  return access.at(organisationScope(organisationId)).revoke({ principal: device(deviceId) });
}
