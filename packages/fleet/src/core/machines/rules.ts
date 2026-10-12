import type * as digitalocean from '@pulumi/digitalocean';
import * as openstack from '@pulumi/openstack';
import type * as pulumi from '@pulumi/pulumi';
import type { FirewallRule } from '../contracts';
import { portRange, portText } from '../firewall';

// DigitalOcean requires a port range for TCP and UDP; a portless rule means every port.
function digitalOceanPorts(rule: FirewallRule): string | undefined {
  if (rule.protocol === 'icmp') return undefined;
  return portText(rule) ?? '1-65535';
}

export function toDigitalOceanInbound(rule: FirewallRule): digitalocean.types.input.FirewallInboundRule {
  return { protocol: rule.protocol, portRange: digitalOceanPorts(rule), sourceAddresses: [...rule.sourceCidrs] };
}

export function toDigitalOceanOutbound(rule: FirewallRule): digitalocean.types.input.FirewallOutboundRule {
  return { protocol: rule.protocol, portRange: digitalOceanPorts(rule), destinationAddresses: [...rule.sourceCidrs] };
}

export type RuleDirection = 'ingress' | 'egress';

export interface OpenStackRuleSpec {
  /** Stable by content (protocol, ports, CIDR), so reordering rules or CIDRs never replaces one. */
  key: string;
  direction: RuleDirection;
  ethertype: 'IPv4' | 'IPv6';
  protocol: FirewallRule['protocol'];
  portRangeMin?: number;
  portRangeMax?: number;
  remoteIpPrefix: string;
}

/** One OpenStack rule per CIDR (security group rules take a single prefix), deduplicated. */
export function expandOpenStackRules(direction: RuleDirection, rules: readonly FirewallRule[]): OpenStackRuleSpec[] {
  const specs = new Map<string, OpenStackRuleSpec>();
  for (const rule of rules) {
    const range = rule.port === undefined ? undefined : portRange(rule.port);
    for (const cidr of rule.sourceCidrs) {
      // IPv4 never contains "--", while compressed IPv6 always does, so the slug stays unambiguous.
      const slug = cidr.replace('/', '_').replace(/[.:]/g, '-');
      const key = `${direction}-${rule.protocol}-${portText(rule) ?? 'all'}-${slug}`;
      specs.set(key, {
        key,
        direction,
        ethertype: cidr.includes(':') ? 'IPv6' : 'IPv4',
        protocol: rule.protocol,
        portRangeMin: range?.from,
        portRangeMax: range?.to,
        remoteIpPrefix: cidr
      });
    }
  }
  return [...specs.values()];
}

export function createOpenStackRules(
  name: string,
  target: { securityGroupId: pulumi.Input<string>; region: string },
  direction: RuleDirection,
  rules: readonly FirewallRule[],
  parent: pulumi.Resource
): openstack.networking.SecGroupRule[] {
  return expandOpenStackRules(direction, rules).map(
    spec =>
      new openstack.networking.SecGroupRule(
        `${name}-${spec.key}`,
        {
          securityGroupId: target.securityGroupId,
          region: target.region,
          direction: spec.direction,
          ethertype: spec.ethertype,
          protocol: spec.protocol,
          portRangeMin: spec.portRangeMin,
          portRangeMax: spec.portRangeMax,
          remoteIpPrefix: spec.remoteIpPrefix
        },
        { parent }
      )
  );
}
