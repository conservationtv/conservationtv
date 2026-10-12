import * as pulumi from '@pulumi/pulumi';
import type { NodeDeployment } from '../core/workload';
import { requireServiceEndpoint, serviceEndpointUrl, type ServiceEndpoint } from '../core/endpoints';
import { MOQ_HTTPS_ENDPOINT, MOQ_WEBTRANSPORT_ENDPOINT } from './relayApp';

export interface RelayNodeDirectoryEntry {
  id: string;
  region: string;
  providerRegion: string;
  priority: number;
  publicHostname: string;
  publicAddress: string;
  connectUrl: string;
  webtransportUrl: string;
  publicHealthUrl: string;
  endpoints: Record<string, ServiceEndpoint>;
  cloudflareMeshNodeId?: string;
  cloudflareMeshNodeName?: string;
  cloudflareMeshNodeStatus?: string;
}

export function buildMoqDirectory(nodes: readonly NodeDeployment[]): pulumi.Output<RelayNodeDirectoryEntry[]> {
  return pulumi.all(
    nodes.map(node => {
      // Resolve relay endpoints and include health paths and mesh metadata only when present.
      const mesh = node.contributions.find(contribution => contribution.name === 'cloudflare-mesh')?.summary;
      const https = requireServiceEndpoint(node.endpoints, MOQ_HTTPS_ENDPOINT);
      const webtransport = requireServiceEndpoint(node.endpoints, MOQ_WEBTRANSPORT_ENDPOINT);
      return pulumi.output({
        id: node.node.id,
        region: node.node.displayName,
        providerRegion: node.node.providerRegion,
        priority: node.node.priority,
        publicHostname: node.hostname,
        publicAddress: node.machine.address,
        connectUrl: serviceEndpointUrl(https, node.hostname),
        webtransportUrl: serviceEndpointUrl(webtransport, node.hostname),
        publicHealthUrl: serviceEndpointUrl(https, node.hostname, https.paths?.health),
        endpoints: node.endpoints,
        cloudflareMeshNodeId: mesh?.nodeId,
        cloudflareMeshNodeName: mesh?.nodeName,
        cloudflareMeshNodeStatus: mesh?.nodeStatus
      });
    })
  );
}
