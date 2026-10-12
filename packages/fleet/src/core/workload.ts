import * as pulumi from '@pulumi/pulumi';
import type { Addon, HostAddonContribution } from './addons/types';
import type { DnsRegistrar } from './dns/types';
import type { Fleet } from './fleet';
import { ComposeHost, composeHostClaims, type ComposeApp } from './host/composeHost';
import type { FirewallIntent, Machine } from './machine';
import { ingressFromServiceEndpoints, mergeFirewallIntents } from './machine';
import { mergeServiceEndpoints, type ServiceEndpoint } from './endpoints';
import { sanitizeName } from './naming';
import { byPriorityThenId, validateNodes, type Node } from './node';

export interface NodeContext {
  fleet: Fleet;
  node: Node;
  workloadName: string;
  hostname: string;
}

export type ComposeAppFactory = (context: NodeContext) => ComposeApp;

export interface ComposeWorkloadArgs {
  fleet: Fleet;
  nodes: Node[];
  domain: string;
  dns?: DnsRegistrar;
  /** Extra ingress beyond SSH and what public service endpoints imply. */
  ingress?: FirewallIntent[];
  app: ComposeAppFactory;
  addons?: Addon[];
  rollout?: 'parallel' | 'serial';
}

export interface NodeDeploymentArgs {
  fleet: Fleet;
  workloadName: string;
  node: Node;
  hostname: string;
  dns?: DnsRegistrar;
  ingress?: FirewallIntent[];
  app: ComposeAppFactory;
  addons: Addon[];
  deployAfter?: pulumi.Resource[];
}

export interface WorkloadNodeSummary {
  id: string;
  provider: string;
  providerRegion: string;
  priority: number;
  hostname: string;
  address: string;
  addressV6?: string;
  healthUrl?: string;
  endpoints: Record<string, ServiceEndpoint>;
  mesh?: MeshSummary;
}

interface MeshSummary {
  nodeId: string;
  nodeName: string;
  status: string;
}

/** One workload's deployment onto one Node: compose host, DNS, and firewall policy. */
export class NodeDeployment extends pulumi.ComponentResource {
  public readonly node: Node;
  public readonly hostname: string;
  public readonly machine: Machine;
  public readonly host: ComposeHost;
  public readonly contributions: HostAddonContribution[];
  public readonly nodeAddonHosts: ComposeHost[];
  public readonly app: ComposeApp;
  public readonly endpoints: Readonly<Record<string, ServiceEndpoint>>;
  public readonly summary: pulumi.Output<WorkloadNodeSummary>;
  public readonly sshAlias: string;

  // Attach shared and workload addons, merge host claims and ingress, then deploy in dependency order.
  public constructor(name: string, args: NodeDeploymentArgs, opts?: pulumi.ComponentResourceOptions) {
    super('fleet:core:NodeDeployment', name, {}, opts);
    this.node = args.node;
    this.hostname = args.hostname;
    this.sshAlias = `${args.fleet.namePrefix}-${args.workloadName}-${args.node.id}`;
    const context: NodeContext = {
      fleet: args.fleet,
      node: args.node,
      workloadName: args.workloadName,
      hostname: args.hostname
    };
    const addonAttachments = args.addons.map(addon => ({
      addon,
      attachment: args.node.attachAddon(addon, context)
    }));
    this.contributions = addonAttachments.map(({ attachment }) => attachment.contribution);
    const workloadContributions = addonAttachments
      .filter(({ addon }) => addon.scope === 'workload')
      .map(({ attachment }) => attachment.contribution);
    const nodeAddonApps = addonAttachments
      .filter(({ addon, attachment }) => addon.scope === 'node' && attachment.deploy)
      .map(({ attachment }) => nodeAddonApp(attachment.contribution));
    this.app = args.app(context);
    this.endpoints = mergeServiceEndpoints([
      { owner: this.app.name, services: this.app.services, endpoints: this.app.endpoints },
      ...this.contributions.map(contribution => ({
        owner: contribution.name,
        services: contribution.services,
        endpoints: contribution.endpoints
      }))
    ]);
    const deployedEndpoints = mergeServiceEndpoints([
      { owner: this.app.name, services: this.app.services, endpoints: this.app.endpoints },
      ...workloadContributions.map(contribution => ({
        owner: contribution.name,
        services: contribution.services,
        endpoints: contribution.endpoints
      })),
      ...nodeAddonApps.map(app => ({ owner: app.name, services: app.services, endpoints: app.endpoints }))
    ]);
    const ingress = mergeFirewallIntents([...ingressFromServiceEndpoints(deployedEndpoints), ...(args.ingress ?? [])]);
    const workloadClaims = composeHostClaims(this.app, workloadContributions);
    const nodeAddonClaims = nodeAddonApps.map(app => composeHostClaims(app));
    const attachment = args.node.attach({
      workloadName: args.workloadName,
      hostname: args.hostname,
      ingress,
      endpoints: deployedEndpoints,
      paths: [workloadClaims.paths, ...nodeAddonClaims.map(claims => claims.paths)].flat(),
      containerNames: [workloadClaims.containerNames, ...nodeAddonClaims.map(claims => claims.containerNames)].flat()
    });
    this.machine = attachment.machine;
    let nodeDeployAfter = attachment.deployAfter;
    this.nodeAddonHosts = nodeAddonApps.map(app => {
      const host = new ComposeHost(
        `${args.node.machineName}-${app.name}-addon-host`,
        {
          machine: this.machine,
          ssh: args.fleet.ssh,
          sshPrivateKeyPem: args.fleet.bootstrapSshKey.privateKeyPem,
          app,
          deployAfter: nodeDeployAfter
        },
        { parent: args.node }
      );
      nodeDeployAfter = [host];
      return host;
    });
    this.host = new ComposeHost(
      `${name}-host`,
      {
        machine: this.machine,
        ssh: args.fleet.ssh,
        sshPrivateKeyPem: args.fleet.bootstrapSshKey.privateKeyPem,
        app: this.app,
        addons: workloadContributions,
        deployAfter: [...(args.deployAfter ?? []), ...nodeDeployAfter]
      },
      { parent: this }
    );
    args.node.completeAttachment(args.workloadName, this.host);
    args.dns?.createAddressRecords(
      `${name}-dns`,
      {
        hostname: args.hostname,
        address: this.machine.address,
        addressV6: this.machine.addressV6
      },
      { parent: this }
    );

    const mesh = this.contributions.find(contribution => contribution.name === 'cloudflare-mesh')?.summary;
    this.summary = pulumi.output({
      id: args.node.id,
      provider: args.node.provider.providerName,
      providerRegion: args.node.providerRegion,
      priority: args.node.priority,
      hostname: args.hostname,
      address: this.machine.address,
      addressV6: this.machine.addressV6,
      healthUrl: this.app.healthUrl,
      endpoints: this.endpoints,
      mesh: mesh
        ? {
            nodeId: mesh.nodeId,
            nodeName: mesh.nodeName,
            status: mesh.nodeStatus
          }
        : undefined
    });
    this.registerOutputs({ summary: this.summary, hostname: this.hostname, address: this.machine.address });
  }
}

function nodeAddonApp(contribution: HostAddonContribution): ComposeApp {
  if (sanitizeName(contribution.name) !== contribution.name) {
    throw new Error(`Node-scoped addon name "${contribution.name}" must already be a sanitized name.`);
  }
  return {
    name: contribution.name,
    dir: `/opt/vps-fleet/addons/${contribution.name}`,
    services: contribution.services,
    volumes: contribution.volumes,
    files: contribution.files ?? [],
    systemdUnits: contribution.systemdUnits,
    deploySteps: contribution.deploySteps ?? [],
    endpoints: contribution.endpoints
  };
}

export class ComposeWorkload extends pulumi.ComponentResource {
  public readonly nodes: ReadonlyMap<string, NodeDeployment>;
  public readonly summary: pulumi.Output<WorkloadNodeSummary[]>;
  public readonly sshConfig: pulumi.Output<string>;
  public readonly workloadName: string;

  // Validate fleet membership and hostnames, deploy in priority order, and chain completion for serial rollouts.
  public constructor(
    name: string,
    args: ComposeWorkloadArgs,
    opts?: pulumi.ComponentResourceOptions,
    componentType = 'fleet:core:ComposeWorkload',
    registerBaseOutputs = true
  ) {
    super(componentType, name, {}, opts);
    this.workloadName = name;
    const ordered = [...args.nodes].sort(byPriorityThenId);
    for (const node of ordered) {
      if (node.fleet !== args.fleet) {
        throw new Error(`Node "${node.machineName}" belongs to a different Fleet than workload "${name}".`);
      }
    }
    const hostnames = ordered.map(node => args.fleet.hostnameFor(node, args.domain));
    validateNodes(ordered, hostnames);
    const deployments = new Map<string, NodeDeployment>();
    let previousCompletion: pulumi.Resource[] = [];
    ordered.forEach((node, index) => {
      const deployment = new NodeDeployment(
        `${name}-${node.id}`,
        {
          fleet: args.fleet,
          workloadName: name,
          node,
          hostname: hostnames[index],
          dns: args.dns,
          ingress: args.ingress,
          app: args.app,
          addons: args.addons ?? [],
          deployAfter: args.rollout === 'serial' ? previousCompletion : undefined
        },
        { parent: this }
      );
      deployments.set(node.id, deployment);
      if (args.rollout === 'serial') previousCompletion = deployment.host.completionResources;
    });
    this.nodes = deployments;
    this.summary = pulumi.all([...deployments.values()].map(deployment => deployment.summary));
    this.sshConfig = renderSshConfig([...deployments.values()], args.fleet.ssh.port);
    if (registerBaseOutputs) this.registerOutputs({ summary: this.summary, sshConfig: this.sshConfig });
  }
}

function renderSshConfig(deployments: readonly NodeDeployment[], port: number): pulumi.Output<string> {
  return pulumi
    .all(
      deployments.map(deployment =>
        pulumi.output({
          alias: deployment.sshAlias,
          address: deployment.machine.address,
          user: deployment.machine.sshUsers.deployment
        })
      )
    )
    .apply(
      resolved =>
        `${resolved
          .map(node =>
            [
              `Host ${node.alias}`,
              `  HostName ${node.address}`,
              `  Port ${port}`,
              `  User ${node.user}`,
              '  IdentityFile ./fleet-ssh.key'
            ].join('\n')
          )
          .join('\n\n')}\n`
    );
}
