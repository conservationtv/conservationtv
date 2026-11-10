import type { FC } from 'react';
import { useSuspenseQueries } from '@tanstack/react-query';
import { Link } from 'react-router';
import { DevicesIcon } from '@phosphor-icons/react';
import type { Device, Network } from '@conservationtv/studio-sdk';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@conservationtv/ui/components/empty';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@conservationtv/ui/components/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@conservationtv/ui/components/tabs';

import type { Route } from './+types/devices';
import { CopyButton } from '@/components/common/copy-button';
import { Page, PageDescription, PageHeader, PageHeading, PageTitle } from '@/components/common/page';
import { DeviceDetailsDialog } from '@/components/devices/device-details-dialog';
import { DEVICE_KINDS, DeviceKindIcon } from '@/components/devices/device-kind';
import { devicePathOf, networkNameOf } from '@/components/devices/devices';
import { EditDeviceDialog } from '@/components/devices/edit-device-dialog';
import { useIsAdministrator, useOrganisationId } from '@/hooks/use-organisation';
import { formatDate, shortPublicId } from '@/lib/format';
import { deviceListQueryOptions } from '@/queries/devices';
import { networkListQueryOptions } from '@/queries/networks';

export const meta: Route.MetaFunction = () => [{ title: 'Devices · conservation.tv studio' }];

/**
 * Every device in the organisation, of every kind: the identities its agents, cameras and members' browsers act as.
 * Everyone reads them; administrators rename them and move cameras between networks. Agents and cameras are added and
 * removed on their own pages, and a browser is added when a member signs in on it.
 */
const DevicesRoute: FC = () => {
  const organisationId = useOrganisationId();
  const [devicesQuery, networksQuery] = useSuspenseQueries({
    queries: [deviceListQueryOptions(organisationId), networkListQueryOptions(organisationId)]
  });
  const devices = devicesQuery.data;
  return (
    <Page className="max-w-5xl">
      <PageHeader>
        <PageHeading>
          <PageTitle>Devices</PageTitle>
          <PageDescription>
            The identities your agents, cameras and members’ browsers act as, each with its own key. Agents and cameras
            are added and removed on their own pages; a browser is added when a member signs in on it.
          </PageDescription>
        </PageHeading>
      </PageHeader>
      <Tabs defaultValue="all" className="gap-6">
        <TabsList variant="line" className="w-full justify-start border-b border-border pb-1">
          <TabsTrigger value="all" className="flex-none px-2 text-custom-13">
            All
            <span className="text-muted-foreground tabular-nums">{devices.length}</span>
          </TabsTrigger>
          {DEVICE_KINDS.map(({ kind, plural }) => (
            <TabsTrigger key={kind} value={kind} className="flex-none px-2 text-custom-13">
              {plural}
              <span className="text-muted-foreground tabular-nums">
                {devices.filter(device => device.kind === kind).length}
              </span>
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="all">
          <DeviceTable devices={devices} networks={networksQuery.data} />
        </TabsContent>
        {DEVICE_KINDS.map(({ kind }) => (
          <TabsContent key={kind} value={kind}>
            <DeviceTable devices={devices.filter(device => device.kind === kind)} networks={networksQuery.data} />
          </TabsContent>
        ))}
      </Tabs>
    </Page>
  );
};

export default DevicesRoute;

interface DeviceTableProps {
  devices: Device[];
  networks: Network[];
}

/** The devices as a table, one row each; an empty state when there are none. */
const DeviceTable: FC<DeviceTableProps> = ({ devices, networks }) => {
  if (devices.length === 0) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <DevicesIcon />
          </EmptyMedia>
          <EmptyTitle>No devices here</EmptyTitle>
          <EmptyDescription>Add an agent or a camera, or sign in on a browser, and it appears here.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <Table className="table-fixed text-custom-13">
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="text-custom-12 font-normal text-custom-text-secondary">Name</TableHead>
          <TableHead className="w-20 text-custom-12 font-normal text-custom-text-secondary">Kind</TableHead>
          <TableHead className="w-28 text-custom-12 font-normal text-custom-text-secondary">Network</TableHead>
          <TableHead className="w-36 text-custom-12 font-normal text-custom-text-secondary">Public ID</TableHead>
          <TableHead className="w-28 text-custom-12 font-normal text-custom-text-secondary">Created</TableHead>
          <TableHead className="w-32">
            <span className="sr-only">Actions</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {devices.map(device => (
          <DeviceRow key={device.id} device={device} networks={networks} />
        ))}
      </TableBody>
    </Table>
  );
};

interface DeviceRowProps {
  device: Device;
  networks: Network[];
}

/** A device: its name (linking to its agent's or camera's page), kind, network, public ID and age. */
const DeviceRow: FC<DeviceRowProps> = ({ device, networks }) => {
  const administrator = useIsAdministrator();
  const networkName = networkNameOf(networks, device.networkId);
  const kind = DEVICE_KINDS.find(candidate => candidate.kind === device.kind);
  return (
    <TableRow>
      <TableCell>
        <span className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 text-custom-text-secondary [&_svg]:size-4">
            <DeviceKindIcon kind={device.kind} />
          </span>
          <DeviceName device={device} />
        </span>
      </TableCell>
      <TableCell className="text-custom-text-secondary">{kind?.label ?? device.kind}</TableCell>
      <TableCell className="truncate text-custom-text-secondary" title={networkName}>
        {networkName}
      </TableCell>
      <TableCell>
        <span className="flex items-center gap-1">
          <span className="font-mono text-custom-12 text-custom-text-secondary" title={device.publicId}>
            {shortPublicId(device.publicId)}
          </span>
          <CopyButton value={device.publicId} label={`Copy ${device.name}’s public ID`} />
        </span>
      </TableCell>
      <TableCell className="text-custom-text-secondary">{formatDate(device.createdAt)}</TableCell>
      <TableCell>
        <span className="flex justify-end gap-1">
          <DeviceDetailsDialog device={device} networkName={networkName} />
          {administrator && <EditDeviceDialog device={device} networks={networks} />}
        </span>
      </TableCell>
    </TableRow>
  );
};

interface DeviceNameProps {
  device: Device;
}

/**
 * A device's name, cut to fit with the whole of it on hover: a browser is named after its user agent, which runs long.
 * An agent's or camera's links to its page.
 */
const DeviceName: FC<DeviceNameProps> = ({ device }) => {
  const organisationId = useOrganisationId();
  const path = devicePathOf(organisationId, device);
  if (!path) {
    return (
      <span className="truncate text-foreground" title={device.name}>
        {device.name}
      </span>
    );
  }
  return (
    <Link to={path} className="truncate text-foreground underline-offset-2 hover:underline" title={device.name}>
      {device.name}
    </Link>
  );
};
