import * as pulumi from '@pulumi/pulumi';
import type { Addon, AddonAttachmentContext, HostAddonContribution } from './addons/types';
import type { ServiceEndpoint } from './endpoints';
import type { Fleet } from './fleet';
import { renderCloudInitProfile, type CloudInitProfileArgs } from './host/cloudInit';
import { tcp, type FirewallIntent, type Machine, type MachineProvider } from './machine';

export interface NodeArgs {
  fleet: Fleet;
  provider: MachineProvider;
  providerRegion: string;
  /**
   * Logical node id (lowercase DNS label) used for hostnames, cluster identity, and
   * directory entries. Defaults to the component name. The component name itself must
   * be unique per stack and is used for cloud resource names and tags.
   */
  id?: string;
  displayName?: string;
  size?: string;
  latitude?: number;
  longitude?: number;
  priority?: number;
  metadata?: Record<string, string>;
  enableIpv6?: boolean;
  /** Stable machine FQDN. Defaults to the first attached workload's hostname. */
  hostname?: string;
  cloudInit?: Partial<Omit<CloudInitProfileArgs, 'hostname' | 'fqdn' | 'ssh' | 'sshAuthorizedKeys'>>;
}

export interface NodeAttachArgs {
  workloadName: string;
  hostname: string;
  ingress: FirewallIntent[];
  endpoints: Readonly<Record<string, ServiceEndpoint>>;
  paths: string[];
  containerNames: string[];
}

export interface NodeAttachment {
  machine: Machine;
  deployAfter: pulumi.Resource[];
}

interface NodeAttachmentRecord {
  hostname: string;
}

interface PriorityNode {
  priority?: number;
  id: string;
}

interface NodeIdRecord {
  id: string;
}

export interface NodeAddonAttachment {
  contribution: HostAddonContribution;
  deploy: boolean;
}

/**
 * A named member of the fleet: owns host identity, cloud-init, and the shared
 * machine lifecycle. The machine is provisioned when the first workload attaches.
 */
export class Node extends pulumi.ComponentResource {
  public readonly fleet: Fleet;
  public readonly provider: MachineProvider;
  public readonly providerRegion: string;
  /** Unique component name; used for cloud resource names and tags. */
  public readonly machineName: string;
  /** Logical id used for hostname strategies and directories. */
  public readonly id: string;
  public readonly displayName: string;
  public readonly size?: string;
  public readonly latitude?: number;
  public readonly longitude?: number;
  public readonly priority: number;
  public readonly metadata: Record<string, string>;
  private readonly enableIpv6: boolean;
  private readonly cloudInit?: NodeArgs['cloudInit'];
  private readonly attachments = new Map<string, NodeAttachmentRecord>();
  private readonly hostClaims = new NodeHostClaimRegistry();
  private readonly nodeAddons = new Map<Addon, HostAddonContribution>();
  private readonly nodeAddonNames = new Map<string, Addon>();
  private machineInstance?: Machine;
  private canonicalHostname?: string;
  private previousDeployment?: pulumi.Resource;

  // Apply node defaults and validate its logical ID and optional canonical hostname before attachment.
  public constructor(name: string, args: NodeArgs, opts?: pulumi.ComponentResourceOptions) {
    super('fleet:core:Node', name, {}, opts);
    this.machineName = name;
    this.id = args.id ?? name;
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(this.id)) {
      throw new Error(`Node id "${this.id}" must be a lowercase DNS label.`);
    }
    this.fleet = args.fleet;
    this.provider = args.provider;
    this.providerRegion = args.providerRegion;
    this.displayName = args.displayName ?? this.id;
    this.size = args.size;
    this.latitude = args.latitude;
    this.longitude = args.longitude;
    this.priority = args.priority ?? 0;
    this.metadata = args.metadata ?? {};
    this.enableIpv6 = args.enableIpv6 ?? false;
    this.canonicalHostname = args.hostname;
    if (this.canonicalHostname && !isHostname(this.canonicalHostname)) {
      throw new Error(`Node hostname "${this.canonicalHostname}" must be a valid DNS hostname.`);
    }
    this.cloudInit = args.cloudInit;
    this.registerOutputs({ id: this.id, machineName: this.machineName, providerRegion: this.providerRegion });
  }

  /** @deprecated Use attachedWorkloads. */
  public get attachedWorkload(): string | undefined {
    return this.attachedWorkloads[0];
  }

  public get attachedWorkloads(): readonly string[] {
    return [...this.attachments.keys()];
  }

  public get hostname(): string {
    if (!this.canonicalHostname) {
      throw new Error(`Node "${this.machineName}" has not been attached to a workload yet.`);
    }
    return this.canonicalHostname;
  }

  public get machine(): Machine {
    if (!this.machineInstance) {
      throw new Error(`Node "${this.machineName}" has not been attached to a workload yet.`);
    }
    return this.machineInstance;
  }

  /**
   * Register a workload on this node, provisioning the shared machine if necessary.
   *
   * @internal
   */
  public attach(args: NodeAttachArgs): NodeAttachment {
    if (this.attachments.has(args.workloadName)) {
      throw new Error(`Node "${this.machineName}" is already attached to workload "${args.workloadName}".`);
    }
    this.hostClaims.register(args.workloadName, args.endpoints, args.paths, args.containerNames);

    if (!this.machineInstance) {
      const machineHostname = this.canonicalHostname ?? args.hostname;
      const userData = renderCloudInitProfile(
        `${this.machineName}-cloud-init`,
        {
          ...this.cloudInit,
          hostname: this.id,
          fqdn: machineHostname,
          ssh: this.fleet.ssh,
          sshAuthorizedKeys: [this.fleet.bootstrapSshKey.publicKeyOpenSsh]
        },
        { parent: this }
      );
      this.machineInstance = this.provider.createMachine(
        `${this.machineName}-machine`,
        {
          fleet: this.fleet,
          machineName: this.machineName,
          providerRegion: this.providerRegion,
          size: this.size,
          hostname: machineHostname,
          userData,
          ingress: [tcp(this.fleet.ssh.port, this.fleet.ssh.allowedCidrs)],
          enableIpv6: this.enableIpv6
        },
        { parent: this }
      );
      this.canonicalHostname = machineHostname;
    }

    const ingressResources = this.machineInstance.addIngress(
      `${this.machineName}-${args.workloadName}-ingress`,
      { ingress: args.ingress },
      { parent: this }
    );
    this.attachments.set(args.workloadName, { hostname: args.hostname });
    return {
      machine: this.machineInstance,
      deployAfter: [...ingressResources, ...(this.previousDeployment ? [this.previousDeployment] : [])]
    };
  }

  /** @internal */
  public attachAddon(addon: Addon, context: AddonAttachmentContext): NodeAddonAttachment {
    if (addon.scope === 'workload') return { contribution: addon.attachTo(context), deploy: true };
    const existing = this.nodeAddons.get(addon);
    if (existing) return { contribution: existing, deploy: false };
    const contribution = addon.attachTo({
      ...context,
      hostname: this.canonicalHostname ?? context.hostname
    });
    const existingName = this.nodeAddonNames.get(contribution.name);
    if (existingName) {
      throw new Error(
        `Node "${this.machineName}" already has a different node-scoped addon named "${contribution.name}".`
      );
    }
    this.nodeAddons.set(addon, contribution);
    this.nodeAddonNames.set(contribution.name, addon);
    return { contribution, deploy: true };
  }

  /** @internal */
  public completeAttachment(workloadName: string, deployment: pulumi.Resource): void {
    if (!this.attachments.has(workloadName)) {
      throw new Error(`Node "${this.machineName}" is not attached to workload "${workloadName}".`);
    }
    this.previousDeployment = deployment;
  }
}

interface HostClaim {
  workloadName: string;
  description: string;
}

class NodeHostClaimRegistry {
  private readonly listeners = new Map<string, HostClaim>();
  private readonly paths = new Map<string, HostClaim>();
  private readonly containers = new Map<string, HostClaim>();

  public register(
    workloadName: string,
    endpoints: Readonly<Record<string, ServiceEndpoint>>,
    paths: readonly string[],
    containerNames: readonly string[]
  ): void {
    const listeners = new Map<string, string>();
    for (const endpoint of Object.values(endpoints)) {
      if (endpoint.binding !== 'host') continue;
      const key = `${endpoint.transport}:${endpoint.port}`;
      if (!listeners.has(key)) listeners.set(key, `endpoint "${endpoint.id}"`);
    }
    this.assertAvailable('Host listener', workloadName, listeners, this.listeners);
    this.assertAvailable('Remote file path', workloadName, uniqueClaims(paths), this.paths);
    this.assertAvailable('Container name', workloadName, uniqueClaims(containerNames), this.containers);
    this.commit(workloadName, listeners, this.listeners);
    this.commit(workloadName, uniqueClaims(paths), this.paths);
    this.commit(workloadName, uniqueClaims(containerNames), this.containers);
  }

  private assertAvailable(
    kind: string,
    workloadName: string,
    claims: ReadonlyMap<string, string>,
    existingClaims: ReadonlyMap<string, HostClaim>
  ): void {
    for (const [key, description] of claims) {
      const existing = existingClaims.get(key);
      if (existing) {
        throw new Error(
          `${kind} collision on "${key}" between workload "${existing.workloadName}" ` +
            `(${existing.description}) and workload "${workloadName}" (${description}).`
        );
      }
    }
  }

  private commit(workloadName: string, claims: ReadonlyMap<string, string>, target: Map<string, HostClaim>): void {
    for (const [key, description] of claims) target.set(key, { workloadName, description });
  }
}

function uniqueClaims(values: readonly string[]): Map<string, string> {
  return new Map(values.map(value => [value, `"${value}"`]));
}

function isHostname(value: string): boolean {
  return value.length <= 253 && value.split('.').every(part => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(part));
}

export function byPriorityThenId(left: PriorityNode, right: PriorityNode): number {
  return (left.priority ?? 0) - (right.priority ?? 0) || left.id.localeCompare(right.id);
}

// Require at least one node, unique valid IDs, and unique resolved hostnames when supplied.
export function validateNodes(nodes: readonly NodeIdRecord[], hostnames?: readonly string[]): void {
  if (nodes.length === 0) {
    throw new Error('A workload must declare at least one node.');
  }

  const ids = new Set<string>();
  for (const node of nodes) {
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(node.id)) {
      throw new Error(`Node id "${node.id}" must be a lowercase DNS label.`);
    }
    if (ids.has(node.id)) {
      throw new Error(`Duplicate node id "${node.id}".`);
    }
    ids.add(node.id);
  }

  if (hostnames) {
    const seen = new Set<string>();
    for (const hostname of hostnames) {
      if (seen.has(hostname)) {
        throw new Error(`Duplicate resolved hostname "${hostname}".`);
      }
      seen.add(hostname);
    }
  }
}
