import { join } from 'node:path';
import { local, remote, type types as commandTypes } from '@pulumi/command';
import * as pulumi from '@pulumi/pulumi';
import type { FirewallTarget, HostClaimLedger, Machine } from '../contracts';
import { asRemoteScript, shellQuote, writeFileLines } from '../shell';
import { MachineClaimLedger } from './claims';
import { RESTART_SSH, SSHD_CONFIG_PATH, sshdConfig } from './cloudInit';
import { deployUserLines } from './profile';
import { applyProfile, readMachineIdentity, sshConnection, type MachineArgsBase } from './shared';

export interface OvhVpsMachineArgs extends MachineArgsBase {
  /**
   * The VPS to take over, by service name (e.g. `vps-1a2b3c4d.vps.ovh.net`). Order it yourself: OVH's ordering is paid,
   * often out of stock, and slower than its Pulumi provider waits for. The machine reinstalls it on first deploy,
   * erasing everything on it.
   */
  serviceName: string;
  /** OVH's datacentre for the VPS, e.g. `UK` or `GRA`: shown in directories and summaries. */
  region: string;
  /** The image to install, by OVH's name for it. Defaults to `Ubuntu 24.04`. Changing it reinstalls the VPS. */
  image?: string;
}

// The Ubuntu image's default user, which OVH's reinstall gives the fleet key; it only hands over to the deploy user.
const IMAGE_USER = 'ubuntu';
const INSTALL_SCRIPT = join(__dirname, 'ovhVpsInstall.js');

interface Installed {
  ipv4: string;
  ipv6?: string;
}

/**
 * An OVH VPS reinstalled with the fleet key and behind a host firewall, ready once the machine profile is applied.
 *
 * OVH VPS has no cloud firewall and no user data, so three steps replace them:
 * 1. `<name>-install`, a local command calling the OVH API, reinstalls the VPS with the fleet key. It runs again (and
 *    erases the VPS again) when the service, image or fleet key changes, which is when another provider would replace
 *    the machine; its address stays, so `installation` tells remote work to run again.
 * 2. `<name>-handover` connects once as the image's user on port 22 and creates the deploy user and sshd on the fleet
 *    port. Port 22 is closed from then on.
 * 3. The machine profile, as for every machine, with a host firewall carrying the machine's egress rules.
 *
 * The OVH credentials come from the environment where Pulumi runs (see `ovhVpsInstall`). Removing the machine leaves the
 * VPS and its subscription; end it with `ovhcloud vps terminate`. Leave OVH's Edge Network Firewall off for the VPS's
 * address: enabled, it drops UDP 443 even where a rule allows it, which breaks QUIC.
 */
export class OvhVpsMachine extends pulumi.ComponentResource implements Machine {
  public readonly id: string;
  public readonly displayName: string;
  public readonly provider = 'ovh-vps';
  public readonly region: string;
  public readonly hostname: string;
  public readonly address: pulumi.Output<string>;
  public readonly addressV6?: pulumi.Output<string>;
  public readonly connection: pulumi.Output<commandTypes.input.remote.ConnectionArgs>;
  public readonly sudo = true;
  public readonly ready: pulumi.Resource;
  public readonly installation: pulumi.Output<string>;
  public readonly firewall: FirewallTarget;
  public readonly claims: HostClaimLedger;

  public constructor(name: string, args: OvhVpsMachineArgs, opts?: pulumi.ComponentResourceOptions) {
    super('fleet:core:OvhVpsMachine', name, {}, opts);
    const { fleet } = args;
    const identity = readMachineIdentity(name, args, 63);
    if (!/^[a-z0-9.-]+$/.test(args.serviceName)) {
      throw new Error(`OVH VPS service name "${args.serviceName}" must look like vps-1a2b3c4d.vps.ovh.net.`);
    }
    this.id = identity.id;
    this.displayName = identity.displayName;
    this.region = args.region;
    this.hostname = identity.hostname;
    this.claims = new MachineClaimLedger(this.id);
    const image = args.image ?? 'Ubuntu 24.04';

    // The script's path and Node's differ between workstations and CI, so `update` (run when they change) only reads.
    const run = (action: 'install' | 'describe') =>
      `${shellQuote(process.execPath)} ${shellQuote(INSTALL_SCRIPT)} ${action}`;
    const install = new local.Command(
      `${name}-install`,
      {
        create: run('install'),
        update: run('describe'),
        environment: {
          FLEET_OVH_SERVICE: args.serviceName,
          FLEET_OVH_IMAGE: image,
          FLEET_OVH_PUBLIC_KEY: fleet.publicKeyOpenSsh
        },
        triggers: [args.serviceName, image, fleet.publicKeyOpenSsh]
      },
      { parent: this }
    );
    // SAFETY: ovhVpsInstall prints one JSON `Description` on stdout, or exits non-zero and fails the command.
    const installed = install.stdout.apply(stdout => JSON.parse(stdout) as Installed);
    this.installation = install.id;
    this.address = installed.ipv4;
    this.addressV6 = args.enableIpv6
      ? installed.apply(({ ipv6 }) => {
          if (!ipv6) throw new Error(`OVH VPS ${args.serviceName} has no IPv6 address.`);
          return ipv6;
        })
      : undefined;

    const handover = new remote.Command(
      `${name}-handover`,
      {
        connection: sshConnection(fleet, this.address, IMAGE_USER, 22),
        create: pulumi
          .output(fleet.publicKeyOpenSsh)
          .apply(key => asRemoteScript(handoverScript(fleet.ssh.port, key), true)),
        triggers: [this.installation]
      },
      // Port 22 is closed after the first run, so nothing but a reinstall may run this again.
      { parent: this, ignoreChanges: ['create', 'connection'] }
    );

    this.connection = sshConnection(fleet, this.address);
    this.ready = applyProfile(
      name,
      { identity, machine: args, connection: this.connection, hostFirewall: true, installation: this.installation },
      { parent: this, dependsOn: [handover] }
    );
    this.firewall = { kind: 'host', connection: this.connection, ready: this.ready, installation: this.installation };

    this.registerOutputs({ address: this.address, addressV6: this.addressV6, hostname: this.hostname });
  }
}

/** Run once, as the image's user: the deploy user with the fleet key, then sshd on the fleet port only. */
function handoverScript(port: number, key: string): string {
  return [
    'set -eu',
    // OVH's images finish their own first boot with cloud-init; an error there is not ours to stop on.
    'if command -v cloud-init >/dev/null; then cloud-init status --wait >/dev/null || true; fi',
    deployUserLines(key),
    'install -m 0755 -d /etc/ssh/sshd_config.d',
    ...writeFileLines(SSHD_CONFIG_PATH, sshdConfig(port), '0644'),
    RESTART_SSH
  ].join('\n');
}
