import type { FC, ReactNode } from 'react';
import { BrowserIcon, HardDrivesIcon, VideoCameraIcon } from '@phosphor-icons/react';
import type { Device } from '@conservationtv/studio-sdk';

// What a device is: an agent, a camera, or a member's browser, each with the icon it goes by across the app.

export type DeviceKind = Device['kind'];

/** A kind of device and what it is called. */
interface DeviceKindName {
  kind: DeviceKind;
  label: string;
  plural: string;
}

/** Each kind's name, as a list's filter and a row's label read it. */
export const DEVICE_KINDS = [
  { kind: 'agent', label: 'Agent', plural: 'Agents' },
  { kind: 'camera', label: 'Camera', plural: 'Cameras' },
  { kind: 'browser', label: 'Browser', plural: 'Browsers' }
] as const satisfies readonly DeviceKindName[];

const kindIcons = {
  agent: <HardDrivesIcon aria-hidden="true" />,
  camera: <VideoCameraIcon aria-hidden="true" />,
  browser: <BrowserIcon aria-hidden="true" />
} satisfies Record<DeviceKind, ReactNode>;

export interface DeviceKindIconProps {
  kind: DeviceKind;
}

/** The icon a device's kind goes by. */
export const DeviceKindIcon: FC<DeviceKindIconProps> = ({ kind }) => {
  return kindIcons[kind];
};
