import * as digitalocean from '@pulumi/digitalocean';
import * as pulumi from '@pulumi/pulumi';
import type { FirewallRule, FirewallTarget } from '../contracts';
import { resourceName, truncateWithHash } from '../naming';
import { createOpenStackRules, toDigitalOceanInbound } from './rules';

export interface MachineIngressArgs {
  firewall: FirewallTarget;
  rules: FirewallRule[];
}

/** Extra inbound rules on an existing machine, owned by whoever creates this component. */
export class MachineIngress extends pulumi.ComponentResource {
  public constructor(name: string, args: MachineIngressArgs, opts?: pulumi.ComponentResourceOptions) {
    super('fleet:machines:MachineIngress', name, {}, opts);
    const { firewall, rules } = args;
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
      }
    }
    this.registerOutputs({});
  }
}
