import type { Network } from '@conservationtv/studio-sdk';

// Where devices are and where their pages are, as rows and facts write them.

/** The name of the network something is on, or "Internet" when it is on none. */
export function networkNameOf(networks: Network[], networkId: string | null): string {
  if (networkId === null) return 'Internet';
  return networks.find(network => network.id === networkId)?.name ?? 'Unknown network';
}

/** The parts of a device its page is found by. */
interface DevicePageInput {
  id: string;
  kind: string;
}

/** The page of the agent or camera a device is the identity of; none for a browser, which has no page of its own. */
export function devicePathOf(organisationId: string, device: DevicePageInput): string | undefined {
  if (device.kind === 'agent') return `/organisations/${organisationId}/agents/${device.id}`;
  if (device.kind === 'camera') return `/organisations/${organisationId}/cameras/${device.id}`;
  return undefined;
}
