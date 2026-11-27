import type { types as commandTypes } from '@pulumi/command';
import * as openstack from '@pulumi/openstack';
import * as pulumi from '@pulumi/pulumi';
import type { FirewallTarget, HostClaimLedger, Machine } from '../contracts';
import { tcp } from '../firewall';
import { resourceName } from '../naming';
import { MachineClaimLedger } from './claims';
import { createOpenStackRules } from './rules';
import {
  applyProfile,
  machineEgress,
  machineUserData,
  readMachineIdentity,
  sshConnection,
  waitForCloudInit,
  type MachineArgsBase
} from './shared';

export interface OpenStackMachineArgs extends MachineArgsBase {
  /** Defaults to `d2-4`. */
  flavor?: string;
  /** Defaults to `Ubuntu 24.04`. */
  imageName?: string;
  /** Defaults to `Ext-Net`. */
  networkName?: string;
}

/** An instance in its own security group (fleet SSH in, the machine's egress out), ready once the machine profile is applied. */
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
      ...createOpenStackRules(name, target, 'egress', machineEgress(args), this)
    ];

    const instance = new openstack.compute.Instance(
      name,
      {
        name: identity.cloudName,
        region,
        imageName: args.imageName ?? 'Ubuntu 24.04',
        flavorName: args.flavor ?? 'd2-4',
        networks: [{ name: args.networkName ?? 'Ext-Net' }],
        securityGroups: [securityGroup.name],
        userData: machineUserData(identity, args),
        tags
      },
      // Boot only once egress exists, or cloud-init cannot reach package mirrors.
      { parent: this, dependsOn: rules }
    );

    this.address = instance.accessIpV4;
    this.addressV6 = args.enableIpv6 ? instance.accessIpV6 : undefined;
    this.connection = sshConnection(fleet, this.address);
    const cloudInit = waitForCloudInit(name, fleet, this.address, this);
    this.ready = applyProfile(
      name,
      { identity, machine: args, connection: this.connection },
      { parent: this, dependsOn: [cloudInit] }
    );
    this.firewall = { kind: 'openstack', securityGroupId: securityGroup.id, region };

    this.registerOutputs({ address: this.address, addressV6: this.addressV6, hostname: this.hostname });
  }
}
