import { Suspense, type FC } from 'react';
import { useSuspenseQuery } from '@tanstack/react-query';
import { Skeleton } from '@conservationtv/ui/components/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@conservationtv/ui/components/table';

import { protocolLabelOf } from '@/components/gateways/gateways';
import { useOrganisationId } from '@/hooks/use-organisation';
import { formatDateTime, formatRelative } from '@/lib/format';
import { gatewayEndpointListQueryOptions } from '@/queries/gateways';

export interface GatewayEndpointsProps {
  gatewayId: string;
}

/**
 * Where a gateway can be reached right now, by protocol, as the agent running it registered from what its MediaMTX
 * listens on. Registrations lapse soon after the agent stops. Read when shown, under its own boundary, so the list of
 * gateways never reads one per row.
 */
export const GatewayEndpoints: FC<GatewayEndpointsProps> = ({ gatewayId }) => {
  return (
    <Suspense fallback={<Skeleton className="h-24 w-full" />}>
      <EndpointTable gatewayId={gatewayId} />
    </Suspense>
  );
};

interface EndpointTableProps {
  gatewayId: string;
}

const EndpointTable: FC<EndpointTableProps> = ({ gatewayId }) => {
  const organisationId = useOrganisationId();
  const endpointsQuery = useSuspenseQuery(gatewayEndpointListQueryOptions(organisationId, gatewayId));
  const endpoints = endpointsQuery.data;
  if (endpoints.length === 0) {
    return (
      <p className="text-custom-12 text-custom-text-secondary">
        Nothing is registered: no agent is running it right now.
      </p>
    );
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Protocol</TableHead>
          <TableHead>URL</TableHead>
          <TableHead>Registered</TableHead>
          <TableHead>Expires</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {endpoints.map(endpoint => (
          <TableRow key={endpoint.protocol}>
            <TableCell className="text-custom-text-secondary">{protocolLabelOf(endpoint.protocol)}</TableCell>
            <TableCell className="font-mono">{endpoint.url}</TableCell>
            <TableCell title={formatDateTime(endpoint.registeredAt)}>{formatRelative(endpoint.registeredAt)}</TableCell>
            <TableCell title={formatDateTime(endpoint.expiresAt)}>{formatRelative(endpoint.expiresAt)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
};
