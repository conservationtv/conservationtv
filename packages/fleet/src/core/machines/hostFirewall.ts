import { remote } from '@pulumi/command';
import * as pulumi from '@pulumi/pulumi';
import type { FirewallRule, HostFirewallTarget, SshAccess } from '../contracts';
import { portText } from '../firewall';
import { sanitizeName } from '../naming';
import { asRemoteScript, shellQuote, writeFileLines } from '../shell';

/**
 * A default-deny nftables firewall on the machine itself, in both directions, for providers without a cloud firewall.
 *
 * Everything lives in one table, `inet fleet`, so Docker's own tables are never touched. The base file declares the
 * chains and the machine's rules (fleet SSH in, its egress out); deployments add inbound rules as files in
 * `/etc/fleet/firewall.d`, which the base file includes. Loading the base file replaces the table, drop-ins and all, in
 * one transaction, and `fleet-firewall.service` loads it at boot.
 *
 * - `input`: loopback, replies, ICMPv6 (IPv6 needs neighbour discovery), DHCP replies and traffic from Docker's bridges
 *   pass; everything else must match an `inbound` rule.
 * - `forward`: Docker publishes container ports by DNAT, which never reaches `input`, so a DNAT'd connection must match a
 *   `published` rule on the port it was addressed to. Containers on Docker's bridges get the machine's egress rules.
 * - `output`: loopback, replies, ICMPv6, DHCP and traffic to Docker's bridges pass; everything else must match an
 *   `outbound` rule or is refused.
 */
export const HOST_FIREWALL_PATH = '/etc/fleet/firewall.nft';
export const HOST_FIREWALL_DIR = '/etc/fleet/firewall.d';
export const HOST_FIREWALL_UNIT = 'fleet-firewall.service';

const ALL_V4 = '0.0.0.0/0';
const ALL_V6 = '::/0';

/** The base ruleset: the fleet's SSH port in from its allowed sources, `egress` out. */
export function renderHostFirewall(ssh: SshAccess, egress: readonly FirewallRule[]): string {
  const inbound = nftRules('inbound', [{ protocol: 'tcp', port: ssh.port, sourceCidrs: ssh.allowedCidrs }]);
  const outbound = nftRules('outbound', egress);
  return `#!/usr/sbin/nft -f
# Managed by the fleet. Rules for deployments are in ${HOST_FIREWALL_DIR}.
table inet fleet
delete table inet fleet

table inet fleet {
  chain inbound {
${indent(inbound)}
  }

  chain published {
  }

  chain outbound {
${indent(outbound)}
    reject with icmpx admin-prohibited
  }

  chain input {
    type filter hook input priority filter; policy drop;
    iif "lo" accept
    ct state established,related accept
    ct state invalid drop
    meta l4proto ipv6-icmp accept
    udp sport 67 udp dport 68 accept
    udp sport 547 udp dport 546 accept
    iifname "docker0" accept
    iifname "br-*" accept
    jump inbound
  }

  chain forward {
    type filter hook forward priority filter - 1; policy accept;
    ct state established,related accept
    ct status dnat jump published
    ct status dnat drop
    iifname "docker0" oifname != "docker0" jump outbound
    iifname "br-*" oifname != "br-*" jump outbound
  }

  chain output {
    type filter hook output priority filter; policy drop;
    oif "lo" accept
    ct state established,related accept
    meta l4proto ipv6-icmp accept
    udp sport 68 udp dport 67 accept
    udp sport 546 udp dport 547 accept
    oifname "docker0" accept
    oifname "br-*" accept
    jump outbound
  }
}

include "${HOST_FIREWALL_DIR}/*.nft"
`;
}

/** A drop-in adding `rules` to the inbound chains: host listeners and ports Docker publishes. */
export function renderHostRules(rules: readonly FirewallRule[]): string {
  const lines = (['inbound', 'published'] as const).flatMap(chain =>
    nftRules(chain, rules).map(rule => `add rule inet fleet ${chain} ${rule}`)
  );
  return `${lines.join('\n')}\n`;
}

/** The systemd unit that loads the base file (and its drop-ins) at boot, before the network comes up. */
export function hostFirewallUnit(): string {
  return `[Unit]
Description=Fleet host firewall (nftables)
DefaultDependencies=no
Before=network-pre.target shutdown.target
Wants=network-pre.target
Conflicts=shutdown.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/nft -f ${HOST_FIREWALL_PATH}
ExecReload=/usr/sbin/nft -f ${HOST_FIREWALL_PATH}

[Install]
WantedBy=sysinit.target
`;
}

/** Check the whole ruleset first, then load it: a broken drop-in never replaces a working firewall. */
export const RELOAD_HOST_FIREWALL = `nft -c -f ${HOST_FIREWALL_PATH}\nnft -f ${HOST_FIREWALL_PATH}`;

type Chain = 'inbound' | 'published' | 'outbound';

/** One nftables rule body per address family a rule covers, each ending in `accept`. */
export function nftRules(chain: Chain, rules: readonly FirewallRule[]): string[] {
  return rules.flatMap(rule => {
    // A rule's CIDRs split by family, since nftables matches `ip` and `ip6` addresses separately; a family covering
    // every address matches on the family alone. A rule with no meaning in the chain (ICMP to a published port) renders
    // nothing.
    const match = protocolMatch(chain, rule);
    if (match === undefined) return [];
    const v4 = rule.sourceCidrs.filter(cidr => !cidr.includes(':'));
    const v6 = rule.sourceCidrs.filter(cidr => cidr.includes(':'));
    const direction = chain === 'outbound' ? 'daddr' : 'saddr';
    return [
      ...(v4.length ? [`${familyMatch('ip', direction, v4, ALL_V4)} ${match(4)} accept`] : []),
      ...(v6.length ? [`${familyMatch('ip6', direction, v6, ALL_V6)} ${match(6)} accept`] : [])
    ];
  });
}

function familyMatch(family: 'ip' | 'ip6', direction: 'saddr' | 'daddr', cidrs: string[], all: string): string {
  if (cidrs.includes(all)) return `meta nfproto ${family === 'ip' ? 'ipv4' : 'ipv6'}`;
  return `${family} ${direction} { ${cidrs.join(', ')} }`;
}

// The protocol and port part of a rule. ICMP has no ports (and ICMPv6 always passes); a rule without ports matches the
// whole protocol; a published port is matched on the port it was addressed to, before Docker's DNAT rewrote it.
function protocolMatch(chain: Chain, rule: FirewallRule): ((family: 4 | 6) => string) | undefined {
  if (rule.protocol === 'icmp') {
    // ICMPv6 always passes; ICMP to a published port means nothing.
    return chain === 'published' ? undefined : family => `meta l4proto ${family === 4 ? 'icmp' : 'ipv6-icmp'}`;
  }
  const ports = portText(rule);
  if (ports === undefined) return () => `meta l4proto ${rule.protocol}`;
  return chain === 'published'
    ? () => `meta l4proto ${rule.protocol} ct original proto-dst ${ports}`
    : () => `${rule.protocol} dport ${ports}`;
}

function indent(lines: string[]): string {
  return lines.map(line => `    ${line}`).join('\n');
}

export interface HostIngressArgs {
  firewall: HostFirewallTarget;
  rules: readonly FirewallRule[];
}

/** Writes `rules` as a drop-in named for `name` and reloads; removing the component removes the drop-in. */
export function createHostRules(name: string, args: HostIngressArgs, parent: pulumi.Resource): remote.Command {
  const path = `${HOST_FIREWALL_DIR}/${sanitizeName(name)}.nft`;
  const write = asRemoteScript(
    ['set -eu', 'umask 077', ...writeFileLines(path, renderHostRules(args.rules), '0600'), RELOAD_HOST_FIREWALL].join(
      '\n'
    ),
    true
  );
  const remove = asRemoteScript(`set -eu\nrm -f ${shellQuote(path)}\n${RELOAD_HOST_FIREWALL}`, true);
  return new remote.Command(
    name,
    {
      connection: args.firewall.connection,
      create: write,
      update: write,
      delete: remove,
      triggers: args.firewall.installation === undefined ? [] : [args.firewall.installation]
    },
    { parent, dependsOn: [args.firewall.ready] }
  );
}
