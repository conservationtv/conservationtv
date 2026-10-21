import { device } from '@conservationtv/umbrella';
import { organisationDevice } from '../db/roles.ts';
import { devices } from '../db/schema.ts';
import { trustedTransaction, useAccess } from '../db/transaction.ts';
import { ApiFailure } from '../errors.ts';
import { useUser } from '../middleware/principal.ts';
import { organisationScope } from '../organisations/membership.ts';

// Every device is a principal of its organisation, `device(<id>)`, holding `organisationDevice` there: it reads the
// organisation's devices, for iroh allowlists. The grant is made in the transaction that creates the device and
// revoked in the one that deletes it, so a device never exists without it. Request sessions cannot write grants, so
// creating and deleting devices is trusted code, after checking the principal's own permissions on devices.

/** Make the device a principal of its organisation. */
export function grantDevice(organisationId: string, deviceId: string) {
  const access = useAccess();
  return access.at(organisationScope(organisationId)).grant({ principal: device(deviceId), role: organisationDevice });
}

/** Revoke every grant the device holds in its organisation. */
export function revokeDevice(organisationId: string, deviceId: string) {
  const access = useAccess();
  return access.at(organisationScope(organisationId)).revoke({ principal: device(deviceId) });
}

/**
 * Run `change` in a trusted transaction, which may write grants, once the user may `action` the organisation's
 * devices: `not_found` if they cannot see them, `forbidden` if they may not. The same decision row-level security
 * would make, since it comes from the devices table's own roles.
 */
export function changeDevices<Result>(
  organisationId: string,
  action: 'create' | 'remove',
  change: () => Promise<Result>
) {
  return trustedTransaction(async () => {
    const access = useAccess();
    const principal = useUser();
    // Invisible devices are not found; visible ones the principal may not change are forbidden.
    const decision = await access.inspect({ principal, resource: devices, scope: organisationScope(organisationId) });
    if (!decision.permissions.read?.allowed) throw new ApiFailure('not_found');
    if (!decision.permissions[action]?.allowed) throw new ApiFailure('forbidden');
    return change();
  });
}
