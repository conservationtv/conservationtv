import type { types as commandTypes } from '@pulumi/command';
import * as openstack from '@pulumi/openstack';
import * as pulumi from '@pulumi/pulumi';
import type { FirewallTarget, HostClaimLedger, Machine } from '../contracts';
import { ALLOW_ALL_EGRESS, tcp } from '../firewall';
import { resourceName } from '../naming';
import { MachineClaimLedger } from './claims';
import { createOpenStackRules } from './rules';
import { machineUserData, readMachineIdentity, sshConnection, waitForCloudInit, type MachineArgsBase } from './shared';

export interface OpenStackMachineArgs extends MachineArgsBase {
  /** Defaults to `d2-4`. */
  flavor?: string;
  /** Defaults to `Ubuntu 24.04`. */
  imageName?: string;
  /** Defaults to `Ext-Net`. */
  networkName?: string;
}

// The Ubuntu image's default user; cloud-init installs the fleet key for root, the keypair for this user.
const USER = 'ubuntu';

/** An instance in its own security group (fleet SSH ingress, all egress), waiting for cloud-init. */
export class OpenStackMachine extends pulumi.ComponentResource implements Machine {
  public readonly id: string;
  public readonly displayName: string;
  public readonly provider = 'openstack';
  public readonly region: string;
  public readonly hostname: string;
  public readonly address: pulumi.Output<string>;
  public readonly addressV6?: pulumi.Output<string>;
  public readonly connection: pulumi.Output<commandTypes.input.remote.ConnectionArgs>;
  public readonly sudo = true;
  public readonly ready: pulumi.Resource;
  public readonly firewall: FirewallTarget;
  public readonly claims: HostClaimLedger;

  public constructor(name: string, args: OpenStackMachineArgs, opts?: pulumi.ComponentResourceOptions) {
    super('fleet:core:OpenStackMachine', name, {}, opts);
    const { fleet, region } = args;
    const identity = readMachineIdentity(name, args, 63);
    this.id = identity.id;
    this.displayName = identity.displayName;
    this.region = region;
    this.hostname = identity.hostname;
    this.claims = new MachineClaimLedger(this.id);
    const tags = [fleet.namePrefix, resourceName(fleet.namePrefix, fleet.environment), identity.cloudName];

    // Keypairs are per region and Nova accepts the same public key under several names, so each
    // machine owns one rather than sharing a region-wide keypair that some machine would have to create.
    const keyPair = new openstack.compute.Keypair(
      `${name}-keypair`,
      { name: identity.cloudName, publicKey: fleet.publicKeyOpenSsh, region },
      { parent: this, deleteBeforeReplace: true }
    );

    const securityGroup = new openstack.networking.SecGroup(
      `${name}-security-group`,
      {
        name: identity.cloudName,
        description: `${fleet.namePrefix} ${fleet.environment} ${identity.id}`,
        region,
        deleteDefaultRules: true,
        tags
      },
      { parent: this }
    );
    const target = { securityGroupId: securityGroup.id, region };
    const rules = [
      ...createOpenStackRules(name, target, 'ingress', [tcp(fleet.ssh.port, fleet.ssh.allowedCidrs)], this),
      ...createOpenStackRules(name, target, 'egress', ALLOW_ALL_EGRESS, this)
    ];

    const instance = new openstack.compute.Instance(
      name,
      {
        name: identity.cloudName,
        region,
        imageName: args.imageName ?? 'Ubuntu 24.04',
        flavorName: args.flavor ?? 'd2-4',
        keyPair: keyPair.name,
        networks: [{ name: args.networkName ?? 'Ext-Net' }],
        securityGroups: [securityGroup.name],
        userData: machineUserData(name, identity, args, this),
        tags
      },
      // Boot only once egress exists, or cloud-init cannot reach package mirrors.
      { parent: this, dependsOn: rules }
    );

    this.address = instance.accessIpV4;
    this.addressV6 = args.enableIpv6 ? instance.accessIpV6 : undefined;
    this.connection = sshConnection(fleet, this.address, USER);
    this.ready = waitForCloudInit(name, fleet, this.address, USER, this);
    this.firewall = { kind: 'openstack', securityGroupId: securityGroup.id, region };

    this.registerOutputs({ address: this.address, addressV6: this.addressV6, hostname: this.hostname });
  }
}
