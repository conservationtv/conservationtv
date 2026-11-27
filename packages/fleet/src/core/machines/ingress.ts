import * as digitalocean from '@pulumi/digitalocean';
import * as pulumi from '@pulumi/pulumi';
import type { FirewallRule, FirewallTarget } from '../contracts';
import { resourceName, truncateWithHash } from '../naming';
import { createHostRules } from './hostFirewall';
import { createOpenStackRules, toDigitalOceanInbound } from './rules';

export interface MachineIngressArgs {
  firewall: FirewallTarget;
  rules: FirewallRule[];
}

/** Extra inbound rules on an existing machine, owned by whoever creates this component. */
export class MachineIngress extends pulumi.ComponentResource {
  public constructor(name: string, args: MachineIngressArgs, opts?: pulumi.ComponentResourceOptions) {
    super('fleet:core:MachineIngress', name, {}, opts);
    const { firewall, rules } = args;
    // Each firewall model takes rules its own way: a DigitalOcean firewall attached to the droplet, OpenStack rules in
    // the machine's security group, or a drop-in file in the machine's own nftables firewall.
    if (rules.length) {
      switch (firewall.kind) {
        case 'digitalocean':
          new digitalocean.Firewall(
            name,
            {
              name: truncateWithHash(resourceName(firewall.cloudName, name), 64),
              dropletIds: [firewall.dropletId],
              inboundRules: rules.map(toDigitalOceanInbound),
              outboundRules: []
            },
            { parent: this }
          );
          break;
        case 'openstack':
          createOpenStackRules(name, firewall, 'ingress', rules, this);
          break;
        case 'host':
          createHostRules(name, { firewall, rules }, this);
          break;
      }
    }
    this.registerOutputs({});
  }
}
