import type { FC } from 'react';
import type { Device } from '@conservationtv/studio-sdk';
import { Button } from '@conservationtv/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from '@conservationtv/ui/components/dialog';

import { CopyButton } from '@/components/common/copy-button';
import { Fact, FactLabel, Facts, FactValue } from '@/components/common/page';
import { DeviceAddresses } from '@/components/devices/device-addresses';
import { DEVICE_KINDS } from '@/components/devices/device-kind';

export interface DeviceDetailsDialogProps {
  device: Device;
  /** The name of the network it is on, or "Internet". */
  networkName: string;
}

/**
 * A device's identity in full, and where it last said it can be reached. Its addresses are read only while the dialog
 * is open.
 */
export const DeviceDetailsDialog: FC<DeviceDetailsDialogProps> = ({ device, networkName }) => {
  const kind = DEVICE_KINDS.find(candidate => candidate.kind === device.kind)?.label ?? device.kind;
  return (
    <Dialog>
      <DialogTrigger render={<Button variant="ghost" size="sm" />}>Details</DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="truncate" title={device.name}>
            {device.name}
          </DialogTitle>
          <DialogDescription>
            {kind} · {networkName}
          </DialogDescription>
        </DialogHeader>
        <Facts className="grid-cols-1 gap-y-4">
          <Fact>
            <FactLabel>Public ID</FactLabel>
            <FactValue className="flex items-start gap-1 whitespace-normal">
              <span className="min-w-0 font-mono text-custom-12 break-all">{device.publicId}</span>
              <CopyButton value={device.publicId} label="Copy public ID" />
            </FactValue>
          </Fact>
          <Fact>
            <FactLabel>Reported addresses</FactLabel>
            <dd className="min-w-0">
              <DeviceAddresses deviceId={device.id} />
            </dd>
          </Fact>
        </Facts>
      </DialogContent>
    </Dialog>
  );
};
