import type { FirewallRule, PortRange } from './contracts';
import { ANYWHERE, assertPort, readCidrs } from './validate';

export function tcp(port: number | PortRange, sourceCidrs: readonly string[] = ANYWHERE): FirewallRule {
  return portRule('tcp', port, sourceCidrs);
}

export function udp(port: number | PortRange, sourceCidrs: readonly string[] = ANYWHERE): FirewallRule {
  return portRule('udp', port, sourceCidrs);
}

export function icmp(sourceCidrs: readonly string[] = ANYWHERE): FirewallRule {
  return { protocol: 'icmp', sourceCidrs: readCidrs(sourceCidrs, 'icmp sourceCidrs') };
}

/** Unrestricted outbound TCP, UDP and ICMP. */
export const ALLOW_ALL_EGRESS: readonly FirewallRule[] = [
  { protocol: 'tcp', port: { from: 1, to: 65535 }, sourceCidrs: [...ANYWHERE] },
  { protocol: 'udp', port: { from: 1, to: 65535 }, sourceCidrs: [...ANYWHERE] },
  { protocol: 'icmp', sourceCidrs: [...ANYWHERE] }
];

function portRule(protocol: 'tcp' | 'udp', port: number | PortRange, sourceCidrs: readonly string[]): FirewallRule {
  const { from, to } = portRange(port);
  assertPort(from, `${protocol} port`);
  assertPort(to, `${protocol} port`);
  if (from > to) throw new Error(`Invalid ${protocol} port range ${from}-${to}.`);
  return { protocol, port, sourceCidrs: readCidrs(sourceCidrs, `${protocol} ${from} sourceCidrs`) };
}

export function portRange(port: number | PortRange): PortRange {
  // eslint-disable-next-line anti-slop/no-runtime-typeof -- a rule's port is a single number or a range.
  return typeof port === 'number' ? { from: port, to: port } : port;
}

/** `443`, `1-65535`, or undefined when the rule covers every port. */
export function portText(rule: FirewallRule): string | undefined {
  if (rule.port === undefined) return undefined;
  const { from, to } = portRange(rule.port);
  return from === to ? String(from) : `${from}-${to}`;
}

/** Combine rules for the same protocol and ports, unioning their sources. */
export function mergeFirewallRules(rules: readonly FirewallRule[]): FirewallRule[] {
  const merged = new Map<string, FirewallRule>();
  for (const rule of rules) {
    const key = `${rule.protocol}:${portText(rule) ?? 'all'}`;
    const existing = merged.get(key);
    merged.set(
      key,
      existing
        ? { ...existing, sourceCidrs: [...new Set([...existing.sourceCidrs, ...rule.sourceCidrs])] }
        : { ...rule, sourceCidrs: [...rule.sourceCidrs] }
    );
  }
  return [...merged.values()];
}
