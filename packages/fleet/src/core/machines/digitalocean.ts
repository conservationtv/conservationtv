import type { types as commandTypes } from '@pulumi/command';
import * as digitalocean from '@pulumi/digitalocean';
import * as pulumi from '@pulumi/pulumi';
import type { FirewallTarget, HostClaimLedger, Machine } from '../contracts';
import { ALLOW_ALL_EGRESS, tcp } from '../firewall';
import { resourceName } from '../naming';
import { MachineClaimLedger } from './claims';
import { toDigitalOceanInbound, toDigitalOceanOutbound } from './rules';
import { machineUserData, readMachineIdentity, sshConnection, waitForCloudInit, type MachineArgsBase } from './shared';

export interface DigitalOceanMachineArgs extends MachineArgsBase {
  /** Droplet size slug. Defaults to `s-1vcpu-2gb`. */
  size?: string;
  /** Droplet image slug. Defaults to `ubuntu-24-04-x64`. */
  image?: string;
  /**
   * DigitalOcean SSH key IDs or fingerprints to register on the droplet. Access never depends on
   * them (cloud-init installs the fleet key), but without one DigitalOcean emails a root password.
   * DigitalOcean rejects duplicate public keys per account, so create one `digitalocean.SshKey`
   * for the fleet key and pass its id to every machine.
   */
  sshKeys?: pulumi.Input<string>[];
  /** DigitalOcean project ID to assign the droplet to. Unassigned droplets land in the account's default project. */
  project?: pulumi.Input<string>;
}

const USER = 'root';

/** A droplet with its base firewall (fleet SSH ingress, all egress), waiting for cloud-init. */
export class DigitalOceanMachine extends pulumi.ComponentResource implements Machine {
  public readonly id: string;
  public readonly displayName: string;
  public readonly provider = 'digitalocean';
  public readonly region: string;
  public readonly hostname: string;
  public readonly address: pulumi.Output<string>;
  public readonly addressV6?: pulumi.Output<string>;
  public readonly connection: pulumi.Output<commandTypes.input.remote.ConnectionArgs>;
  public readonly sudo = false;
  public readonly ready: pulumi.Resource;
  public readonly firewall: FirewallTarget;
  public readonly claims: HostClaimLedger;

  /** Applies the size, image and IPv6 defaults, then boots the droplet behind its base firewall. */
  public constructor(name: string, args: DigitalOceanMachineArgs, opts?: pulumi.ComponentResourceOptions) {
    super('fleet:core:DigitalOceanMachine', name, {}, opts);
    const { fleet } = args;
    const identity = readMachineIdentity(name, args, 64);
    this.id = identity.id;
    this.displayName = identity.displayName;
    this.region = args.region;
    this.hostname = identity.hostname;
    this.claims = new MachineClaimLedger(this.id);

    const droplet = new digitalocean.Droplet(
      name,
      {
        name: identity.cloudName,
        image: args.image ?? 'ubuntu-24-04-x64',
        size: args.size ?? 's-1vcpu-2gb',
        region: args.region,
        sshKeys: args.sshKeys,
        tags: [fleet.namePrefix, resourceName(fleet.namePrefix, fleet.environment), identity.cloudName],
        monitoring: true,
        ipv6: args.enableIpv6 ?? false,
        userData: machineUserData(identity, args)
      },
      { parent: this }
    );

    const dropletId = droplet.id.apply(Number);
    new digitalocean.Firewall(
      `${name}-firewall`,
      {
        name: identity.cloudName,
        dropletIds: [dropletId],
        inboundRules: [toDigitalOceanInbound(tcp(fleet.ssh.port, fleet.ssh.allowedCidrs))],
        outboundRules: ALLOW_ALL_EGRESS.map(toDigitalOceanOutbound)
      },
      { parent: this }
    );

    if (args.project !== undefined) {
      new digitalocean.ProjectResources(
        `${name}-project`,
        { project: args.project, resources: [droplet.dropletUrn] },
        { parent: this }
      );
    }

    this.address = droplet.ipv4Address;
    this.addressV6 = args.enableIpv6 ? droplet.ipv6Address : undefined;
    this.connection = sshConnection(fleet, this.address, USER);
    this.ready = waitForCloudInit(name, fleet, this.address, USER, this);
    this.firewall = { kind: 'digitalocean', dropletId, cloudName: identity.cloudName };

    this.registerOutputs({ address: this.address, addressV6: this.addressV6, hostname: this.hostname });
  }
}
