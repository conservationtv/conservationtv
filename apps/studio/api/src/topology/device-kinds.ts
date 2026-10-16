/** What a device is: each kind is a table that shares the device's ID and adds its own columns. */
export const DEVICE_KINDS = ['agent', 'camera'] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];
