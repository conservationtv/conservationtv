import { describe, expect, it } from 'vitest';
import { icmp, tcp, udp } from '../src/core/firewall';
import { MachineClaimLedger } from '../src/core/machines/claims';
import { expandOpenStackRules, toDigitalOceanInbound, toDigitalOceanOutbound } from '../src/core/machines/rules';

describe('provider firewall translation', () => {
  it('translates rules to DigitalOcean rules', () => {
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
    expect(toDigitalOceanInbound({ protocol: 'tcp', sourceCidrs: ['::/0'] }).portRange).toBe('1-65535');
  });

  it('expands OpenStack rules per CIDR and ethertype', () => {
    expect(expandOpenStackRules('ingress', [tcp(443)])).toEqual([
      expect.objectContaining({ ethertype: 'IPv4', remoteIpPrefix: '0.0.0.0/0', portRangeMin: 443, portRangeMax: 443 }),
      expect.objectContaining({ ethertype: 'IPv6', remoteIpPrefix: '::/0', portRangeMin: 443, portRangeMax: 443 })
    ]);
  });

  it('keys OpenStack rules by content so reordering keeps them and duplicates collapse', () => {
    const keys = (cidrs: string[]) => expandOpenStackRules('ingress', [tcp(443, cidrs)]).map(rule => rule.key);
    expect(keys(['10.0.0.0/8', '192.0.2.0/24']).sort()).toEqual(keys(['192.0.2.0/24', '10.0.0.0/8']).sort());
    expect(expandOpenStackRules('egress', [tcp(443, ['10.0.0.0/8']), tcp(443, ['10.0.0.0/8'])])).toHaveLength(1);
    expect(new Set(keys(['0.0.0.0/0', '::/0', '2001:db8::/32'])).size).toBe(3);
  });

  it('rejects invalid CIDRs before provider construction', () => {
    expect(() => tcp(443, ['not-a-cidr'])).toThrow(/IPv4 or IPv6 CIDR/);
  });
});

describe('host claim ledger', () => {
  const claims = (overrides: Partial<{ listeners: string[]; paths: string[]; containerNames: string[] }>) => ({
    listeners: [],
    paths: [],
    containerNames: [],
    ...overrides
  });

  it('lets one owner claim the same key repeatedly', () => {
    const ledger = new MachineClaimLedger('lon-1');
    ledger.claim('moq', claims({ listeners: ['udp:443'] }));
    expect(() => ledger.claim('moq', claims({ listeners: ['udp:443'] }))).not.toThrow();
  });

  it('rejects a key claimed by a different owner, naming both owners and the kind', () => {
    const ledger = new MachineClaimLedger('lon-1');
    ledger.claim('moq', claims({ paths: ['/opt/moq/docker-compose.yml'] }));
    expect(() => ledger.claim('iroh', claims({ paths: ['/opt/moq/docker-compose.yml'] }))).toThrow(
      /lon-1.*path "\/opt\/moq\/docker-compose.yml".*"moq".*"iroh"/
    );
    ledger.claim('moq', claims({ containerNames: ['relay'] }));
    expect(() => ledger.claim('iroh', claims({ containerNames: ['relay'] }))).toThrow(/container "relay"/);
  });

  it('records nothing from a rejected claim', () => {
    const ledger = new MachineClaimLedger('lon-1');
    ledger.claim('moq', claims({ listeners: ['tcp:443'] }));
    expect(() => ledger.claim('iroh', claims({ listeners: ['tcp:80', 'tcp:443'] }))).toThrow(/listener/);
    expect(() => ledger.claim('netdata', claims({ listeners: ['tcp:80'] }))).not.toThrow();
  });
});
