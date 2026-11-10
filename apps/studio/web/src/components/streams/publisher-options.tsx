import type { FC } from 'react';
import type { Device } from '@conservationtv/studio-sdk';
import { NativeSelectOptGroup, NativeSelectOption } from '@conservationtv/ui/components/native-select';

const kindLabels = { agent: 'Agents', browser: 'Browsers', camera: 'Cameras' } satisfies Record<Device['kind'], string>;

/** The order the kinds are offered in: what usually sends a delivery first. */
const KINDS: Device['kind'][] = ['agent', 'browser', 'camera'];

export interface PublisherOptionsProps {
  devices: Device[];
}

/**
 * The devices that could be pinned to send a delivery, as a select's options grouped by kind: any device may be, so
 * every form that chooses a publisher offers the same ones. The choice of none is the caller's own first option.
 */
export const PublisherOptions: FC<PublisherOptionsProps> = ({ devices }) => {
  return KINDS.map(kind => {
    const ofKind = devices.filter(device => device.kind === kind);
    if (ofKind.length === 0) return null;
    return (
      <NativeSelectOptGroup key={kind} label={kindLabels[kind]}>
        {ofKind.map(device => (
          <NativeSelectOption key={device.id} value={device.id}>
            {device.name}
          </NativeSelectOption>
        ))}
      </NativeSelectOptGroup>
    );
  });
};
