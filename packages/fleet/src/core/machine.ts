import * as pulumi from '@pulumi/pulumi';
import type { Fleet } from './fleet';
import type { FirewallIntent } from './firewall';

export * from './endpointIngress';
export * from './firewall';

export interface MachineSshUsers {
  cloudInit: string;
  deployment: string;
}

export interface MachineArgs {
  fleet: Fleet;
  /** Unique machine name inside the fleet; used for cloud resource names and tags. */
  machineName: string;
  providerRegion: string;
  size?: string;
  hostname: string;
  userData: pulumi.Input<string>;
  ingress: FirewallIntent[];
  egress?: FirewallIntent[];
  enableIpv6?: boolean;
}

export interface MachineIngressArgs {
  ingress: FirewallIntent[];
}

export interface Machine {
  readonly address: pulumi.Output<string>;
  readonly addressV6?: pulumi.Output<string>;
  readonly sshUsers: MachineSshUsers;
  readonly resource: pulumi.Resource;
  addIngress(name: string, args: MachineIngressArgs, opts?: pulumi.ResourceOptions): pulumi.Resource[];
}

export class MachineComponent extends pulumi.ComponentResource implements Machine {
  public readonly address: pulumi.Output<string>;
  public readonly addressV6?: pulumi.Output<string>;
  public readonly sshUsers: MachineSshUsers;
  public readonly resource: pulumi.Resource;
  private readonly addMachineIngress: Machine['addIngress'];

  public constructor(
    name: string,
    factory: (parent: pulumi.ComponentResource) => Machine,
    opts?: pulumi.ComponentResourceOptions
  ) {
    super('fleet:core:Machine', name, {}, opts);
    const machine = factory(this);
    this.address = machine.address;
    this.addressV6 = machine.addressV6;
    this.sshUsers = machine.sshUsers;
    this.resource = machine.resource;
    this.addMachineIngress = machine.addIngress.bind(machine);
    this.registerOutputs({ address: this.address, addressV6: this.addressV6, sshUsers: this.sshUsers });
  }

  public addIngress(name: string, args: MachineIngressArgs, opts?: pulumi.ResourceOptions): pulumi.Resource[] {
    return this.addMachineIngress(name, args, opts);
  }
}

export abstract class MachineProvider extends pulumi.ComponentResource {
  public abstract readonly providerName: string;

  protected constructor(type: string, name: string, opts?: pulumi.ComponentResourceOptions) {
    super(type, name, {}, opts);
  }

  public abstract createMachine(name: string, args: MachineArgs, opts?: pulumi.ComponentResourceOptions): Machine;
}
