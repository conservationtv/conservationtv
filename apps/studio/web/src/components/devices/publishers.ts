import type { Device, Exposure, Stream } from '@conservationtv/studio-sdk';

import { exposureSubjectId, type SubjectState } from '@/components/devices/subjects';
import type { ListedGateway } from '@/components/gateways/gateways';

// What is publishing what, to where: each delivery of a stream (an exposure) that names the device publishing it,
// grouped by that device. Derived from the organisation's lists alone.

/** One stream a device publishes to one gateway. */
export interface Publication {
  stream: Stream;
  exposure: Exposure;
  /** Where it is published: undefined if the gateway is gone. */
  gateway: ListedGateway | undefined;
  /** What agents last said about the delivery. */
  state: SubjectState | undefined;
}

/** A device and everything it publishes. */
export interface Publisher {
  deviceId: string;
  /** Undefined if the device is gone. */
  device: Device | undefined;
  publications: Publication[];
}

/** What the lists are read from. */
export interface PublisherInputs {
  streams: Stream[];
  devices: Device[];
  gateways: ListedGateway[];
  states: Map<string, SubjectState>;
}

/** Every exposure with a publisher, grouped by publishing device, in the order the devices were made. */
export function publishersOf({ streams, devices, gateways, states }: PublisherInputs): Publisher[] {
  const publications = streams.flatMap(stream =>
    stream.exposures.flatMap(exposure => {
      if (exposure.publisherDeviceId === null) return [];
      const gateway = gateways.find(candidate => candidate.id === exposure.gatewayId);
      const state = states.get(exposureSubjectId(exposure.id));
      return [{ deviceId: exposure.publisherDeviceId, publication: { stream, exposure, gateway, state } }];
    })
  );
  const deviceIds = [...new Set(publications.map(entry => entry.deviceId))];
  const order = (deviceId: string) => {
    const index = devices.findIndex(device => device.id === deviceId);
    return index === -1 ? devices.length : index;
  };
  return deviceIds
    .toSorted((a, b) => order(a) - order(b))
    .map(deviceId => ({
      deviceId,
      device: devices.find(device => device.id === deviceId),
      publications: publications.filter(entry => entry.deviceId === deviceId).map(entry => entry.publication)
    }));
}
