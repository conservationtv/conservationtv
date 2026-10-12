import * as pulumi from '@pulumi/pulumi';
import type { NodeDeployment } from '../core/workload';
import { requireServiceEndpoint, serviceEndpointUrl, type ServiceEndpoint } from '../core/endpoints';
import { IROH_HTTPS_ENDPOINT } from './relayApp';

export interface IrohRelayNodeDirectoryEntry {
  id: string;
  region: string;
  providerRegion: string;
  priority: number;
  publicHostname: string;
  publicAddress: string;
  relayUrl: string;
  endpoints: Record<string, ServiceEndpoint>;
  cloudflareMeshNodeId?: string;
  cloudflareMeshNodeName?: string;
  cloudflareMeshNodeStatus?: string;
}

export function buildIrohDirectory(nodes: readonly NodeDeployment[]): pulumi.Output<IrohRelayNodeDirectoryEntry[]> {
  return pulumi.all(
    nodes.map(node => {
      // Resolve the relay endpoint and include mesh metadata only when the addon provides it.
      const mesh = node.contributions.find(contribution => contribution.name === 'cloudflare-mesh')?.summary;
      const relay = requireServiceEndpoint(node.endpoints, IROH_HTTPS_ENDPOINT);
      return pulumi.output({
        id: node.node.id,
        region: node.node.displayName,
        providerRegion: node.node.providerRegion,
        priority: node.node.priority,
        publicHostname: node.hostname,
        publicAddress: node.machine.address,
        relayUrl: serviceEndpointUrl(relay, node.hostname),
        endpoints: node.endpoints,
        cloudflareMeshNodeId: mesh?.nodeId,
        cloudflareMeshNodeName: mesh?.nodeName,
        cloudflareMeshNodeStatus: mesh?.nodeStatus
      });
    })
  );
}
