import { readCidrs } from './config';

export type FirewallProtocol = 'tcp' | 'udp' | 'icmp';

export interface FirewallPortRange {
  from: number;
  to: number;
}

export type FirewallPort = number | FirewallPortRange;

export interface PortRangeResult {
  from?: number;
  to?: number;
  text?: string;
}

export interface FirewallIntent {
  protocol: FirewallProtocol;
  port?: FirewallPort;
  sourceCidrs: string[];
}

export function tcp(port: FirewallPort, sourceCidrs = ['0.0.0.0/0', '::/0']): FirewallIntent {
  return firewall('tcp', port, sourceCidrs);
}

export function udp(port: FirewallPort, sourceCidrs = ['0.0.0.0/0', '::/0']): FirewallIntent {
  return firewall('udp', port, sourceCidrs);
}

export function icmp(sourceCidrs = ['0.0.0.0/0', '::/0']): FirewallIntent {
  return { protocol: 'icmp', sourceCidrs: readCidrs(sourceCidrs, 'firewall sourceCidrs') };
}

// Normalize single ports to ranges, then validate ordered integer bounds and source CIDRs.
function firewall(protocol: 'tcp' | 'udp', port: FirewallPort, sourceCidrs: string[]): FirewallIntent {
  const range = port instanceof Object && 'from' in port ? port : { from: port, to: port };
  const { from, to } = range;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to > 65535 || from > to) {
    throw new Error(`Invalid ${protocol} port range ${from}-${to}.`);
  }
  return { protocol, port, sourceCidrs: readCidrs(sourceCidrs, 'firewall sourceCidrs') };
}

// Preserve portless rules and render either a single port or an inclusive range.
export function portRange(intent: FirewallIntent): PortRangeResult {
  if (intent.port === undefined) return {};
  const range =
    intent.port instanceof Object && 'from' in intent.port ? intent.port : { from: intent.port, to: intent.port };
  const { from, to } = range;
  return { from, to, text: from === to ? String(from) : `${from}-${to}` };
}

export function mergeFirewallIntents(intents: readonly FirewallIntent[]): FirewallIntent[] {
  const merged = new Map<string, FirewallIntent>();
  for (const intent of intents) {
    const range = portRange(intent);
    const key = `${intent.protocol}:${range.text ?? 'all'}`;
    const existing = merged.get(key);
    if (existing) {
      existing.sourceCidrs = [...new Set([...existing.sourceCidrs, ...intent.sourceCidrs])];
    } else {
      merged.set(key, { ...intent, sourceCidrs: [...intent.sourceCidrs] });
    }
  }
  return [...merged.values()];
}
