import { readCidrs } from './config';
import type { ServiceEndpoint } from './endpoints';
import type { FirewallIntent } from './firewall';

// Combine public host listeners by transport and port, merging their allowed source CIDRs.
export function ingressFromServiceEndpoints(endpoints: Readonly<Record<string, ServiceEndpoint>>): FirewallIntent[] {
  const intents = new Map<string, FirewallIntent>();
  for (const endpoint of Object.values(endpoints)) {
    // Ignore private or compose-only endpoints, then merge CIDRs for listeners that share a port.
    if (endpoint.binding !== 'host' || endpoint.visibility !== 'public') continue;
    const key = `${endpoint.transport}:${endpoint.port}`;
    const cidrs = readCidrs(endpoint.sourceCidrs ?? ['0.0.0.0/0', '::/0'], `${endpoint.id} sourceCidrs`);
    const existing = intents.get(key);
    if (existing) {
      existing.sourceCidrs = [...new Set([...existing.sourceCidrs, ...cidrs])];
    } else {
      intents.set(key, { protocol: endpoint.transport, port: endpoint.port, sourceCidrs: cidrs });
    }
  }
  return [...intents.values()];
}
