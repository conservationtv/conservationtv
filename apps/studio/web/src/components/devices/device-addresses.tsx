import { Suspense, type FC } from 'react';
import { useSuspenseQuery } from '@tanstack/react-query';
import { Badge } from '@conservationtv/ui/components/badge';
import { Skeleton } from '@conservationtv/ui/components/skeleton';

import { formatRelative } from '@/lib/format';
import { useOrganisationId } from '@/hooks/use-organisation';
import { deviceAddressListQueryOptions } from '@/queries/devices';

export interface DeviceAddressesProps {
  deviceId: string;
}

/**
 * Where a device last said it can be reached on its own network, preferred first: what it found on its interfaces,
 * not what anything has checked. Read when shown, under its own boundary, so a list never reads one per row.
 */
export const DeviceAddresses: FC<DeviceAddressesProps> = ({ deviceId }) => {
  return (
    <Suspense fallback={<Skeleton className="h-16 w-full" />}>
      <AddressList deviceId={deviceId} />
    </Suspense>
  );
};

interface AddressListProps {
  deviceId: string;
}

const AddressList: FC<AddressListProps> = ({ deviceId }) => {
  const organisationId = useOrganisationId();
  const addressesQuery = useSuspenseQuery(deviceAddressListQueryOptions(organisationId, deviceId));
  // Preferred first, whatever order they were reported in.
  const addresses = addressesQuery.data.toSorted((a, b) => Number(b.preferred) - Number(a.preferred));
  const reported = addresses[0];
  if (!reported) return <p className="text-custom-13 text-custom-text-secondary">It hasn’t reported any addresses.</p>;
  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col divide-y divide-border rounded-lg border">
        {addresses.map(address => (
          <li key={`${address.interface}/${address.address}`} className="flex items-center gap-3 px-3 py-1.5">
            <span className="min-w-0 truncate font-mono text-custom-12 text-foreground">{address.address}</span>
            {address.preferred && <Badge variant="secondary">Preferred</Badge>}
            <span className="ml-auto shrink-0 text-custom-12 text-custom-text-secondary">{address.interface}</span>
          </li>
        ))}
      </ul>
      <p className="text-custom-12 text-custom-text-secondary">Reported {formatRelative(reported.reportedAt)}.</p>
    </div>
  );
};
