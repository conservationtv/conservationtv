import * as pulumi from '@pulumi/pulumi';
import { endpointUrl, requireEndpoint } from '../core/compose/endpoints';
import type { ComposeDeployment } from '../core/compose/deployment';
import { ComposeWorkload } from '../core/compose/workload';
import type { DeploymentSummary, DnsZone, PublicTlsMaterial, Rollout, WorkloadTarget } from '../core/contracts';
import { relayDirectory, type RelayDirectoryEntry } from '../relay/directory';
import { IROH_HTTPS_ENDPOINT, irohRelayApp, type IrohRelayAdmission, type IrohRelayPorts } from './relayApp';

export interface IrohRelayClusterArgs {
  relays: WorkloadTarget[];
  /** Must cover every relay hostname. Renewals restart relays without redeploying them. */
  tls: PublicTlsMaterial;
  dns?: DnsZone;
  image?: string;
  admission: IrohRelayAdmission;
  ports?: Partial<IrohRelayPorts>;
  rollout?: Rollout;
}

export interface IrohRelayDirectoryEntry extends RelayDirectoryEntry {
  relayUrl: string;
}

/** Independent Iroh relays sharing one configuration, deployed as one Compose workload. */
export class IrohRelayCluster extends pulumi.ComponentResource {
  public readonly directory: pulumi.Output<IrohRelayDirectoryEntry[]>;
  /** In rollout order. */
  public readonly relayUrls: string[];
  public readonly summary: pulumi.Output<DeploymentSummary[]>;

  public constructor(name: string, args: IrohRelayClusterArgs, opts?: pulumi.ComponentResourceOptions) {
    super('fleet:iroh:RelayCluster', name, {}, opts);
    const workload = new ComposeWorkload(
      name,
      {
        targets: args.relays,
        dns: args.dns,
        rollout: args.rollout,
        app: irohRelayApp({ admission: args.admission, tls: args.tls, ports: args.ports, image: args.image })
      },
      { parent: this, dependsOn: opts?.dependsOn }
    );

    this.relayUrls = workload.deployments.map(relayUrl);
    this.directory = relayDirectory(workload.deployments, deployment => ({ relayUrl: relayUrl(deployment) }));
    this.summary = workload.summary;
    this.registerOutputs({ directory: this.directory, relayUrls: this.relayUrls, summary: this.summary });
  }
}

function relayUrl({ endpoints, target }: ComposeDeployment): string {
  return endpointUrl(requireEndpoint(endpoints, IROH_HTTPS_ENDPOINT), target.hostname);
}
