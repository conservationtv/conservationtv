import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { deviceAddresses } from '../db/schema.ts';
import { useDB } from '../db/transaction.ts';
import type { AuthenticatedDevice } from '../middleware/device.ts';

// The addresses a device reports it can be reached at on its own network (src/db/schemas/device-addresses.ts). The
// device finds them on its interfaces and reports them signed, so storing them is trusted code, as report ingestion
// is: the signature, not a session, says whose they are. A device replaces its set whole, so what is stored is always
// its latest report. Members read them in the request session, where row-level security decides whose.

/** The most addresses one report may carry: a machine with more interfaces than this is reporting something else. */
export const MAX_DEVICE_ADDRESSES = 32;

/** An address the device found on one of its interfaces. */
export const ReportedAddressSchema = z.strictObject({
  address: z.union([z.ipv4(), z.ipv6()]).describe('An IPv4 or IPv6 address of the device, without a scope.'),
  interface: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .describe('The interface it was found on, as the device names it, such as `eth0` or `en0`.'),
  preferred: z
    .boolean()
    .default(false)
    .describe("Whether this is the address the device's default route leaves by: at most one is.")
});
export type ReportedAddress = z.output<typeof ReportedAddressSchema>;

/** Every address the device reports, replacing whatever it reported before. */
export const ReportedAddressesSchema = z.strictObject({
  addresses: z
    .array(ReportedAddressSchema)
    .max(MAX_DEVICE_ADDRESSES)
    .refine(addresses => new Set(addresses.map(address => address.address)).size === addresses.length, {
      message: 'Each address may appear once'
    })
    .refine(addresses => addresses.filter(address => address.preferred).length <= 1, {
      message: 'At most one address is preferred'
    })
    .describe('The addresses, in no order. Empty when the device found none it can be reached at.')
});
export type ReportedAddresses = z.output<typeof ReportedAddressesSchema>;

const selection = {
  address: deviceAddresses.address,
  interface: deviceAddresses.interface,
  preferred: deviceAddresses.preferred,
  reportedAt: deviceAddresses.reportedAt
};

/**
 * Replace the device's addresses with what it reports now, all reported at once: trusted code, since the device's
 * signature authenticates it. Returns what is stored.
 */
export async function replaceDeviceAddresses(device: AuthenticatedDevice, reported: ReportedAddresses) {
  const db = useDB({ trusted: true });
  await db.delete(deviceAddresses).where(eq(deviceAddresses.deviceId, device.id));
  if (reported.addresses.length === 0) return [];
  const reportedAt = new Date();
  const rows = reported.addresses.map(address => ({
    organisationId: device.organisationId,
    deviceId: device.id,
    ...address,
    reportedAt
  }));
  return db.insert(deviceAddresses).values(rows).returning(selection);
}

/** The addresses the device last reported, preferred first, then by address. */
export function listDeviceAddresses(organisationId: string, deviceId: string) {
  const db = useDB();
  return db
    .select(selection)
    .from(deviceAddresses)
    .where(and(eq(deviceAddresses.organisationId, organisationId), eq(deviceAddresses.deviceId, deviceId)))
    .orderBy(deviceAddresses.preferred, deviceAddresses.address);
}
