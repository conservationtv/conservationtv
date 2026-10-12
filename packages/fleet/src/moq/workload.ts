import * as pulumi from '@pulumi/pulumi';
import type { Addon } from '../core/addons/types';
import type { AcmeIssuer } from '../core/certs/acme';
import { wildcardNodeCertNames } from '../core/certs/acme';
import { readHttpsUrl } from '../core/config';
import type { DnsRegistrar } from '../core/dns/types';
import type { Fleet } from '../core/fleet';
import type { Node } from '../core/node';
import { ComposeWorkload } from '../core/workload';
import { buildMoqDirectory, type RelayNodeDirectoryEntry } from './directory';
import { moqRelayApp } from './relayApp';

export interface MoqRelayNode {
  node: Node;
  /** Other relays in this workload that this relay dials. */
  peers?: Node[];
}

export interface MoqRelayWorkloadArgs {
  fleet: Fleet;
  relays: MoqRelayNode[];
  domain: string;
  dns?: DnsRegistrar;
  acme: AcmeIssuer;
  image?: string;
  /** HTTPS origin of the admission service relays call back to. */
  authOrigin: string;
  /** Shared key relays present on admission callbacks. */
  authToken: pulumi.Input<string>;
  /** Shared peer credential: 32 bytes encoded as lowercase hex. */
  clusterToken: pulumi.Input<string>;
  addons?: Addon[];
  rollout?: 'parallel' | 'serial';
}

export class MoqRelayWorkload extends ComposeWorkload {
  public readonly authOrigin: string;
  public readonly directory: pulumi.Output<RelayNodeDirectoryEntry[]>;
  public readonly clusterNodeUrls: string[];
  public readonly clusterPeersByNodeUrl: Record<string, string[]>;
  public readonly publicCertificateNotAfter: pulumi.Output<string>;

  public constructor(name: string, args: MoqRelayWorkloadArgs, opts?: pulumi.ComponentResourceOptions) {
    const authOrigin = readAuthOrigin(args.authOrigin);
    validatePeers(args.relays);
    const urlFor = (node: Node) => `https://${args.fleet.hostnameFor(node, args.domain)}/`;
    const relays = new Map(args.relays.map(relay => [relay.node.id, relay]));
    const certificate = args.acme.issueCertificate(`${name}-public`, {
      commonName: args.domain,
      subjectAlternativeNames: wildcardNodeCertNames(args.domain)
    });
    super(
      name,
      {
        fleet: args.fleet,
        nodes: args.relays.map(relay => relay.node),
        domain: args.domain,
        dns: args.dns,
        addons: args.addons,
        rollout: args.rollout,
        app: context => {
          const relay = relays.get(context.node.id)!;
          return moqRelayApp({
            nodeId: context.node.id,
            hostname: context.hostname,
            image: args.image,
            authOrigin,
            authToken: args.authToken,
            peers: (relay.peers ?? []).map(urlFor),
            clusterToken: args.clusterToken,
            publicTls: certificate
          });
        }
      },
      opts,
      'fleet:moq:RelayWorkload',
      false
    );
    this.authOrigin = authOrigin;
    this.clusterNodeUrls = args.relays.map(relay => urlFor(relay.node));
    this.clusterPeersByNodeUrl = Object.fromEntries(
      args.relays.map(relay => [urlFor(relay.node), (relay.peers ?? []).map(urlFor)])
    );
    this.publicCertificateNotAfter = certificate.notAfter;
    this.directory = buildMoqDirectory([...this.nodes.values()]);
    this.registerOutputs({
      authOrigin: this.authOrigin,
      directory: this.directory,
      summary: this.summary,
      sshConfig: this.sshConfig,
      clusterNodeUrls: this.clusterNodeUrls,
      clusterPeersByNodeUrl: this.clusterPeersByNodeUrl,
      publicCertificateNotAfter: this.publicCertificateNotAfter
    });
  }
}

function readAuthOrigin(value: string): string {
  const origin = readHttpsUrl(value, 'MoQ auth origin');
  if (new URL(origin).origin !== origin) throw new Error('MoQ auth origin must be an HTTPS origin without a path');
  return origin;
}

// Reject peers outside this workload, self-references and repeats before any resources are created.
function validatePeers(relays: readonly MoqRelayNode[]): void {
  const members = new Set(relays.map(relay => relay.node));
  for (const { node, peers = [] } of relays) {
    if (peers.some(peer => peer === node || !members.has(peer)) || new Set(peers).size !== peers.length) {
      throw new Error(`Invalid MoQ peers for ${node.id}`);
    }
  }
}
