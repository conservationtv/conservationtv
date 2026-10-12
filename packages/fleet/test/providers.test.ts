import { describe, expect, it } from 'vitest';
import { icmp, tcp, udp } from '../src/core/machine';
import { toDigitalOceanInbound, toDigitalOceanOutbound } from '../src/core/providers/digitalocean';
import { expandOpenStackRuleIntents } from '../src/core/providers/openstack';

describe('provider firewall translation', () => {
  it('translates intents to DigitalOcean rules', () => {
    expect(toDigitalOceanInbound(tcp(443))).toEqual({
      protocol: 'tcp',
      portRange: '443',
      sourceAddresses: ['0.0.0.0/0', '::/0']
    });
    expect(toDigitalOceanOutbound(udp({ from: 1000, to: 2000 }, ['10.0.0.0/8']))).toEqual({
      protocol: 'udp',
      portRange: '1000-2000',
      destinationAddresses: ['10.0.0.0/8']
    });
    expect(toDigitalOceanInbound(icmp())).toEqual({
      protocol: 'icmp',
      portRange: undefined,
      sourceAddresses: ['0.0.0.0/0', '::/0']
    });
  });

  it('expands OpenStack rules per CIDR and ethertype', () => {
    const rules = expandOpenStackRuleIntents('ingress', [tcp(443)]);
    expect(rules).toEqual([
      expect.objectContaining({ ethertype: 'IPv4', remoteIpPrefix: '0.0.0.0/0', portRangeMin: 443, portRangeMax: 443 }),
      expect.objectContaining({ ethertype: 'IPv6', remoteIpPrefix: '::/0', portRangeMin: 443, portRangeMax: 443 })
    ]);
  });

  it('rejects invalid CIDRs before provider construction', () => {
    expect(() => tcp(443, ['not-a-cidr'])).toThrow(/valid IPv4 or IPv6 CIDR/);
  });
});
