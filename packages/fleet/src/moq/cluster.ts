import * as pulumi from '@pulumi/pulumi';
import { endpointUrl, requireEndpoint } from '../core/compose/endpoints';
import { ComposeWorkload } from '../core/compose/workload';
import type {
  DeploymentSummary,
  DnsZone,
  Machine,
  PublicTlsMaterial,
  Rollout,
  WorkloadTarget
} from '../core/contracts';
import { readHostname } from '../core/validate';
import { relayDirectory, type RelayDirectoryEntry } from '../relay/directory';
import { MOQ_HTTPS_ENDPOINT, MOQ_WEBTRANSPORT_ENDPOINT, moqNodeUrl, moqRelayApp, type MoqRelayAuth } from './relayApp';

export interface MoqRelay extends WorkloadTarget {
  /** Machines of other relays in this cluster that this relay dials. */
  peers?: Machine[];
}

export interface MoqRelayClusterArgs {
  relays: MoqRelay[];
  /** Must cover every relay hostname. Renewals restart relays without redeploying them. */
  tls: PublicTlsMaterial;
  dns?: DnsZone;
  image?: string;
  auth: MoqRelayAuth;
  rollout?: Rollout;
}

export interface MoqRelayDirectoryEntry extends RelayDirectoryEntry {
  connectUrl: string;
  webtransportUrl: string;
  publicHealthUrl: string;
}

/** MoQ relays with an explicit peer topology, deployed as one Compose workload. */
export class MoqRelayCluster extends pulumi.ComponentResource {
  public readonly directory: pulumi.Output<MoqRelayDirectoryEntry[]>;
  /** In rollout order. */
  public readonly clusterNodeUrls: string[];
  public readonly clusterPeersByNodeUrl: Record<string, string[]>;
  public readonly summary: pulumi.Output<DeploymentSummary[]>;

  public constructor(name: string, args: MoqRelayClusterArgs, opts?: pulumi.ComponentResourceOptions) {
    super('fleet:moq:RelayCluster', name, {}, opts);
    const hostnames = readRelayHostnames(args.relays);
    const nodeUrl = (machine: Machine) => moqNodeUrl(hostnames.get(machine)!);
    const peerUrls = (relay: MoqRelay) => (relay.peers ?? []).map(nodeUrl);
    const relayOn = new Map(args.relays.map(relay => [relay.machine, relay]));

    const workload = new ComposeWorkload(
      name,
      {
        targets: args.relays,
        dns: args.dns,
        rollout: args.rollout,
        app: target =>
          moqRelayApp({
            nodeId: target.machine.id,
            hostname: hostnames.get(target.machine)!,
            peers: peerUrls(relayOn.get(target.machine)!),
            tls: args.tls,
            auth: args.auth,
            image: args.image
          })
      },
      { parent: this, dependsOn: opts?.dependsOn }
    );

    this.clusterNodeUrls = workload.deployments.map(({ target }) => nodeUrl(target.machine));
    this.clusterPeersByNodeUrl = Object.fromEntries(
      args.relays.map(relay => [nodeUrl(relay.machine), peerUrls(relay)])
    );
    this.directory = relayDirectory(workload.deployments, ({ endpoints, target }) => {
      const https = requireEndpoint(endpoints, MOQ_HTTPS_ENDPOINT);
      return {
        connectUrl: endpointUrl(https, target.hostname),
        webtransportUrl: endpointUrl(requireEndpoint(endpoints, MOQ_WEBTRANSPORT_ENDPOINT), target.hostname),
        publicHealthUrl: endpointUrl(https, target.hostname, https.paths?.health)
      };
    });
    this.summary = workload.summary;
    this.registerOutputs({
      directory: this.directory,
      clusterNodeUrls: this.clusterNodeUrls,
      clusterPeersByNodeUrl: this.clusterPeersByNodeUrl,
      summary: this.summary
    });
  }
}

// Peers must be other members of this cluster, each listed once, so every dialled URL is a relay we deploy.
function readRelayHostnames(relays: readonly MoqRelay[]): Map<Machine, string> {
  const hostnames = new Map<Machine, string>();
  for (const { machine, hostname } of relays) {
    hostnames.set(machine, readHostname(hostname, `MoQ relay ${machine.id} hostname`));
  }
  for (const { machine, peers = [] } of relays) {
    for (const peer of peers) {
      if (peer === machine) throw new Error(`MoQ relay ${machine.id} lists itself as a peer.`);
      if (!hostnames.has(peer)) throw new Error(`MoQ relay ${machine.id} peer ${peer.id} is not in this cluster.`);
    }
    if (new Set(peers).size !== peers.length) throw new Error(`MoQ relay ${machine.id} lists a peer more than once.`);
  }
  return hostnames;
}
