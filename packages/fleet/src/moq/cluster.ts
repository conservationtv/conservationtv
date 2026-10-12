import { createHash } from 'node:crypto';
import type { Fleet, HostnameSubject } from '../core/fleet';
import { byPriorityThenId } from '../core/node';

export interface MoqClusterNode extends HostnameSubject {
  priority?: number;
}

export interface MoqClusterTopology {
  clusterNodeUrls: string[];
  clusterPeersByNodeUrl: Record<string, string[]>;
  peersFor(node: MoqClusterNode): string[];
}

export function moqCluster(fleet: Fleet, nodes: readonly MoqClusterNode[], domain: string): MoqClusterTopology {
  const ordered = [...nodes].sort(byPriorityThenId);
  const entries = ordered.map(node => ({ node, url: `https://${fleet.hostnameFor(node, domain)}/` }));
  const clusterPeersByNodeUrl = Object.fromEntries(
    entries.map(({ node, url }) => [
      url,
      entries
        .filter(entry => entry.node.id !== node.id)
        .map(entry => entry.url)
        .sort()
    ])
  );
  return {
    clusterNodeUrls: entries.map(entry => entry.url).sort(),
    clusterPeersByNodeUrl,
    peersFor(node) {
      const url = `https://${fleet.hostnameFor(node, domain)}/`;
      const peers = clusterPeersByNodeUrl[url];
      if (!peers) throw new Error(`Node "${node.id}" is not in this MoQ cluster topology.`);
      return peers;
    }
  };
}

export function stableClusterId(value: string): string {
  const bytes = createHash('sha256').update(value).digest();
  let id = 0n;
  for (const byte of bytes.subarray(0, 7)) id = (id << 8n) | BigInt(byte);
  id &= (1n << 53n) - 1n;
  return (id === 0n ? 1n : id).toString();
}
