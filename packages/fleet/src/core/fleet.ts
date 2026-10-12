import * as pulumi from '@pulumi/pulumi';
import { readSshAccessConfig, type SshAccessConfig } from './config';
import { resourceName } from './naming';
import { BootstrapSshKey } from './ssh';

/** The node identity fields available to hostname strategies. */
export interface HostnameSubject {
  id: string;
  providerRegion?: string;
  metadata?: Record<string, string>;
}

export type HostnameStrategy = (node: HostnameSubject, baseDomain: string) => string;

export const nodesSubdomainStrategy: HostnameStrategy = (node, domain) => `${node.id}.nodes.${domain}`;

export interface FleetArgs {
  namePrefix: string;
  environment: string;
  ssh: SshAccessConfig;
  hostnameStrategy?: HostnameStrategy;
}

export class Fleet extends pulumi.ComponentResource {
  public readonly bootstrapSshKey: BootstrapSshKey;
  public readonly namePrefix: string;
  public readonly environment: string;
  public readonly ssh: SshAccessConfig;
  private readonly hostnameStrategy: HostnameStrategy;

  public constructor(name: string, args: FleetArgs, opts?: pulumi.ComponentResourceOptions) {
    super('fleet:core:Fleet', name, {}, opts);
    this.namePrefix = resourceName(args.namePrefix);
    if (!this.namePrefix) throw new Error('Fleet namePrefix must contain at least one letter or number.');
    this.environment = resourceName(args.environment);
    if (!this.environment) throw new Error('Fleet environment must contain at least one letter or number.');
    this.ssh = readSshAccessConfig(args.ssh);
    this.hostnameStrategy = args.hostnameStrategy ?? nodesSubdomainStrategy;
    this.bootstrapSshKey = new BootstrapSshKey(`${name}-bootstrap-ssh`, { parent: this });
    this.registerOutputs({ namePrefix: this.namePrefix, environment: this.environment });
  }

  public hostnameFor(node: HostnameSubject, domain: string): string {
    const hostname = this.hostnameStrategy(node, domain).toLowerCase().replace(/\.$/, '');
    if (hostname.length > 253 || !hostname.split('.').every(part => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(part))) {
      throw new Error(`Hostname strategy produced invalid hostname "${hostname}" for node "${node.id}".`);
    }
    return hostname;
  }

  /** Cloud tags for a machine, keyed by its unique machine name. */
  public tagsFor(machineName: string): string[] {
    return [
      this.namePrefix,
      resourceName(this.namePrefix, this.environment),
      resourceName(this.namePrefix, machineName)
    ];
  }
}
