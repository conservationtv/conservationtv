import * as openstack from '@pulumi/openstack';
import * as pulumi from '@pulumi/pulumi';
import type { Fleet } from '../fleet';
import {
  MachineComponent,
  MachineProvider,
  portRange,
  type FirewallIntent,
  type Machine,
  type MachineArgs
} from '../machine';
import { resourceName, truncateWithHash } from '../naming';
import { preflightOpenStack, type PreflightOptions } from '../preflight';

export interface OpenStackProviderArgs {
  fleet: Fleet;
  region: string;
  imageName?: string;
  defaultFlavor?: string;
  externalNetworkName?: string;
  preflight?: PreflightOptions;
}

export class OpenStackProvider extends MachineProvider {
  public readonly providerName = 'openstack';
  public readonly imageName: string;
  public readonly externalNetworkName: string;
  private readonly fleet: Fleet;
  private readonly region: string;
  private readonly defaultFlavor: string;
  private readonly keyPairName: pulumi.Output<string>;

  // Check credentials unless a provider was supplied, then apply image, flavor, and network defaults.
  public constructor(name: string, args: OpenStackProviderArgs, opts?: pulumi.ComponentResourceOptions) {
    super('fleet:core:OpenStackProvider', name, opts);
    if (!opts?.providers) preflightOpenStack(args.preflight);
    this.fleet = args.fleet;
    this.region = args.region;
    this.imageName = args.imageName ?? 'Ubuntu 24.04';
    this.defaultFlavor = args.defaultFlavor ?? 'd2-4';
    this.externalNetworkName = args.externalNetworkName ?? 'Ext-Net';
    const keyPair = new openstack.compute.Keypair(
      `${name}-bootstrap`,
      {
        name: truncateWithHash(
          resourceName(args.fleet.namePrefix, args.fleet.environment, name, args.region, 'bootstrap'),
          63
        ),
        publicKey: args.fleet.bootstrapSshKey.publicKeyOpenSsh,
        region: args.region
      },
      { parent: this, deleteBeforeReplace: true }
    );
    this.keyPairName = keyPair.name;
    this.registerOutputs({ keyPairName: this.keyPairName });
  }

  public createMachine(name: string, args: MachineArgs, opts?: pulumi.ComponentResourceOptions): Machine {
    if (args.fleet !== this.fleet) throw new Error('OpenStackProvider cannot provision a node for a different Fleet.');
    return new MachineComponent(name, parent => this.createMachineResources(name, args, parent), opts);
  }

  // Require the configured region, then provision security rules and an instance with optional IPv6.
  private createMachineResources(name: string, args: MachineArgs, parent: pulumi.ComponentResource): Machine {
    if (args.providerRegion !== this.region) {
      throw new Error(
        `OpenStackProvider is configured for ${this.region}, but machine ${args.machineName} requests ${args.providerRegion}. Create one provider component per region.`
      );
    }
    const tags = args.fleet.tagsFor(args.machineName);
    const cloudName = truncateWithHash(
      resourceName(args.fleet.namePrefix, args.fleet.environment, args.machineName),
      63
    );
    const securityGroup = new openstack.networking.SecGroup(
      `${name}-security-group`,
      {
        name: cloudName,
        description: `${args.fleet.namePrefix} ${args.fleet.environment} ${args.machineName}`,
        region: this.region,
        deleteDefaultRules: true,
        tags
      },
      { parent }
    );

    const rules = [
      ...createRules(name, securityGroup.id, this.region, 'ingress', args.ingress, parent),
      ...createRules(name, securityGroup.id, this.region, 'egress', args.egress ?? defaultEgress(), parent)
    ];
    const instance = new openstack.compute.Instance(
      name,
      {
        name: cloudName,
        region: this.region,
        imageName: this.imageName,
        flavorName: args.size ?? this.defaultFlavor,
        keyPair: this.keyPairName,
        networks: [{ name: this.externalNetworkName }],
        securityGroups: [securityGroup.name],
        userData: args.userData,
        tags
      },
      { parent, dependsOn: [securityGroup, ...rules] }
    );

    return {
      address: instance.accessIpV4,
      addressV6: args.enableIpv6 ? instance.accessIpV6 : undefined,
      sshUsers: { cloudInit: 'ubuntu', deployment: 'ubuntu' },
      resource: instance,
      addIngress: (ingressName, ingressArgs, opts) =>
        createRules(ingressName, securityGroup.id, this.region, 'ingress', ingressArgs.ingress, opts?.parent)
    };
  }
}

function createRules(
  name: string,
  securityGroupId: pulumi.Input<string>,
  region: string,
  direction: 'ingress' | 'egress',
  intents: readonly FirewallIntent[],
  parent?: pulumi.Resource
): openstack.networking.SecGroupRule[] {
  return expandOpenStackRuleIntents(direction, intents).map(
    rule =>
      new openstack.networking.SecGroupRule(
        resourceName(
          name,
          direction,
          rule.protocol,
          rule.portText ?? 'all',
          String(rule.intentIndex),
          String(rule.cidrIndex)
        ),
        {
          securityGroupId,
          region,
          direction,
          ethertype: rule.ethertype,
          protocol: rule.protocol,
          portRangeMin: rule.portRangeMin,
          portRangeMax: rule.portRangeMax,
          remoteIpPrefix: rule.remoteIpPrefix
        },
        { parent }
      )
  );
}

export interface OpenStackRuleSpec {
  direction: 'ingress' | 'egress';
  ethertype: 'IPv4' | 'IPv6';
  protocol: 'tcp' | 'udp' | 'icmp';
  portRangeMin?: number;
  portRangeMax?: number;
  portText?: string;
  remoteIpPrefix: string;
  intentIndex: number;
  cidrIndex: number;
}

export function expandOpenStackRuleIntents(
  direction: 'ingress' | 'egress',
  intents: readonly FirewallIntent[]
): OpenStackRuleSpec[] {
  return intents.flatMap((intent, intentIndex) => {
    const range = portRange(intent);
    return intent.sourceCidrs.map((cidr, cidrIndex) => ({
      direction,
      ethertype: cidr.includes(':') ? ('IPv6' as const) : ('IPv4' as const),
      protocol: intent.protocol,
      portRangeMin: range.from,
      portRangeMax: range.to,
      portText: range.text,
      remoteIpPrefix: cidr,
      intentIndex,
      cidrIndex
    }));
  });
}

function defaultEgress(): FirewallIntent[] {
  return [
    { protocol: 'tcp', port: { from: 1, to: 65535 }, sourceCidrs: ['0.0.0.0/0', '::/0'] },
    { protocol: 'udp', port: { from: 1, to: 65535 }, sourceCidrs: ['0.0.0.0/0', '::/0'] },
    { protocol: 'icmp', sourceCidrs: ['0.0.0.0/0', '::/0'] }
  ];
}
