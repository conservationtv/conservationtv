import * as pulumi from '@pulumi/pulumi';
import type {
  ComposeApp,
  ComposeDeploymentArgs,
  DeploymentSummary,
  ServiceEndpoint,
  WorkloadTarget
} from '../contracts';
import { AddressRecords } from '../dns';
import { mergeFirewallRules } from '../firewall';
import { MachineIngress } from '../machines/ingress';
import { readHostname } from '../validate';
import { endpointIngress, hostListeners, resolveEndpoints } from './endpoints';
import { deployComposePlan, planComposeApp } from './lifecycle';

/**
 * One compose app on one machine: its host claims, the firewall rules it implies, the managed
 * lifecycle, and optionally DNS for its hostname.
 */
export class ComposeDeployment extends pulumi.ComponentResource {
  public readonly target: WorkloadTarget;
  public readonly app: ComposeApp;
  public readonly endpoints: Readonly<Record<string, ServiceEndpoint>>;
  public readonly summary: pulumi.Output<DeploymentSummary>;

  public constructor(name: string, args: ComposeDeploymentArgs, opts?: pulumi.ComponentResourceOptions) {
    super('fleet:core:ComposeDeployment', name, {}, opts);
    const { machine } = args.target;
    const hostname = readHostname(args.target.hostname, `Deployment "${name}" hostname`);
    this.target = { ...args.target, hostname };
    this.app = args.app;
    const plan = planComposeApp(args.app);
    this.endpoints = resolveEndpoints(args.app);
    machine.claims.claim(name, {
      listeners: hostListeners(this.endpoints),
      paths: plan.files.map(file => file.path),
      containerNames: plan.containerNames
    });
    for (const warning of plan.warnings) pulumi.log.warn(warning, this);

    // Pulumi children do not inherit a component's dependsOn, so every child gets it explicitly.
    const childOpts = { parent: this, dependsOn: opts?.dependsOn };
    const rules = mergeFirewallRules([...endpointIngress(this.endpoints), ...(args.ingress ?? [])]);
    const ingress = rules.length
      ? [new MachineIngress(`${name}-ingress`, { firewall: machine.firewall, rules }, childOpts)]
      : [];
    deployComposePlan(
      name,
      plan,
      { connection: machine.connection, sudo: machine.sudo },
      pulumi.mergeOptions(childOpts, { dependsOn: [machine.ready, ...ingress] })
    );
    if (args.dns) {
      new AddressRecords(
        `${name}-dns`,
        { zone: args.dns, hostname, address: machine.address, addressV6: machine.addressV6 },
        childOpts
      );
    }

    this.summary = pulumi.output({
      machine: machine.id,
      provider: machine.provider,
      region: machine.region,
      hostname,
      address: machine.address,
      addressV6: machine.addressV6,
      endpoints: this.endpoints
    });
    this.registerOutputs({ summary: this.summary });
  }
}
