import * as digitalocean from '@pulumi/digitalocean';
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
import { preflightDigitalOcean, type PreflightOptions } from '../preflight';

export interface DigitalOceanProviderArgs {
  fleet: Fleet;
  image?: string;
  defaultSize?: string;
  preflight?: PreflightOptions;
}

export class DigitalOceanProvider extends MachineProvider {
  public readonly providerName = 'digitalocean';
  private readonly fleet: Fleet;
  private readonly image: string;
  private readonly defaultSize: string;
  private readonly resourceName: string;
  private readonly sshKeyIds: pulumi.Output<string>[];
  private readonly tags = new Map<string, digitalocean.Tag>();

  // Check credentials unless a provider was supplied, then apply machine defaults and register the bootstrap key.
  public constructor(name: string, args: DigitalOceanProviderArgs, opts?: pulumi.ComponentResourceOptions) {
    super('fleet:core:DigitalOceanProvider', name, opts);
    if (!opts?.providers) preflightDigitalOcean(args.preflight);
    this.fleet = args.fleet;
    this.resourceName = name;
    this.image = args.image ?? 'ubuntu-24-04-x64';
    this.defaultSize = args.defaultSize ?? 's-1vcpu-2gb';
    const key = new digitalocean.SshKey(
      `${name}-bootstrap`,
      {
        name: truncateWithHash(resourceName(args.fleet.namePrefix, args.fleet.environment, name, 'bootstrap'), 64),
        publicKey: args.fleet.bootstrapSshKey.publicKeyOpenSsh
      },
      { parent: this, deleteBeforeReplace: true }
    );
    this.sshKeyIds = [key.id];
    this.registerOutputs({ sshKeyIds: this.sshKeyIds });
  }

  public createMachine(name: string, args: MachineArgs, opts?: pulumi.ComponentResourceOptions): Machine {
    if (args.fleet !== this.fleet)
      throw new Error('DigitalOceanProvider cannot provision a node for a different Fleet.');
    return new MachineComponent(name, parent => this.createMachineResources(name, args, parent), opts);
  }

  // Provision the droplet and firewall with default egress and optional IPv6, exposing later ingress additions.
  private createMachineResources(name: string, args: MachineArgs, parent: pulumi.ComponentResource): Machine {
    const tags = args.fleet.tagsFor(args.machineName);
    const tagResources = this.ensureTags(tags);
    const cloudName = truncateWithHash(
      resourceName(args.fleet.namePrefix, args.fleet.environment, args.machineName),
      64
    );
    const droplet = new digitalocean.Droplet(
      name,
      {
        name: cloudName,
        image: this.image,
        size: args.size ?? this.defaultSize,
        region: args.providerRegion,
        sshKeys: this.sshKeyIds,
        tags,
        monitoring: true,
        ipv6: args.enableIpv6 ?? false,
        userData: args.userData
      },
      { parent, dependsOn: tagResources }
    );

    new digitalocean.Firewall(
      `${name}-firewall`,
      {
        name: cloudName,
        tags: [resourceName(args.fleet.namePrefix, args.machineName)],
        inboundRules: args.ingress.map(toDigitalOceanInbound),
        outboundRules: (args.egress ?? defaultEgress()).map(toDigitalOceanOutbound)
      },
      { parent, dependsOn: tagResources }
    );

    const addressV6 = args.enableIpv6 ? droplet.ipv6Address : undefined;
    return {
      address: droplet.ipv4Address,
      addressV6,
      sshUsers: { cloudInit: 'root', deployment: 'root' },
      resource: droplet,
      addIngress: (ingressName, ingressArgs, opts) => {
        if (ingressArgs.ingress.length === 0) return [];
        const firewall = new digitalocean.Firewall(
          ingressName,
          {
            name: truncateWithHash(resourceName(cloudName, ingressName), 64),
            tags: [resourceName(args.fleet.namePrefix, args.machineName)],
            inboundRules: ingressArgs.ingress.map(toDigitalOceanInbound),
            outboundRules: []
          },
          { ...opts, dependsOn: droplet }
        );
        return [firewall];
      }
    };
  }

  private ensureTags(names: readonly string[]): digitalocean.Tag[] {
    return names.map(tagName => {
      const existing = this.tags.get(tagName);
      if (existing) return existing;
      const tag = new digitalocean.Tag(resourceName(this.resourceName, tagName), { name: tagName }, { parent: this });
      this.tags.set(tagName, tag);
      return tag;
    });
  }
}

export function toDigitalOceanInbound(intent: FirewallIntent): digitalocean.types.input.FirewallInboundRule {
  return {
    protocol: intent.protocol,
    portRange: portRange(intent).text,
    sourceAddresses: intent.sourceCidrs
  };
}

export function toDigitalOceanOutbound(intent: FirewallIntent): digitalocean.types.input.FirewallOutboundRule {
  return {
    protocol: intent.protocol,
    portRange: portRange(intent).text,
    destinationAddresses: intent.sourceCidrs
  };
}

function defaultEgress(): FirewallIntent[] {
  return [
    { protocol: 'tcp', port: { from: 1, to: 65535 }, sourceCidrs: ['0.0.0.0/0', '::/0'] },
    { protocol: 'udp', port: { from: 1, to: 65535 }, sourceCidrs: ['0.0.0.0/0', '::/0'] },
    { protocol: 'icmp', sourceCidrs: ['0.0.0.0/0', '::/0'] }
  ];
}
