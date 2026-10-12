import * as pulumi from '@pulumi/pulumi';
import type { Addon } from '../core/addons/types';
import { wildcardNodeCertNames, type AcmeIssuer } from '../core/certs/acme';
import type { DnsRegistrar } from '../core/dns/types';
import type { Fleet } from '../core/fleet';
import type { Node } from '../core/node';
import { ComposeWorkload } from '../core/workload';
import { buildIrohDirectory, type IrohRelayNodeDirectoryEntry } from './directory';
import { irohRelayApp, type IrohRelayPorts } from './relayApp';

export interface IrohRelayWorkloadArgs {
  fleet: Fleet;
  nodes: Node[];
  domain: string;
  dns?: DnsRegistrar;
  acme: AcmeIssuer;
  image?: string;
  /** Gatekeeper's HTTPS /relays/iroh/admission endpoint. */
  admissionUrl: string;
  /** Must match gatekeeper's IROH_RELAY_TOKEN binding. */
  admissionToken: pulumi.Input<string>;
  ports?: Partial<IrohRelayPorts>;
  addons?: Addon[];
  rollout?: 'parallel' | 'serial';
}

export class IrohRelayWorkload extends ComposeWorkload {
  public readonly directory: pulumi.Output<IrohRelayNodeDirectoryEntry[]>;
  public readonly relayUrls: pulumi.Output<string[]>;
  public readonly publicCertificateNotAfter: pulumi.Output<string>;

  public constructor(name: string, args: IrohRelayWorkloadArgs, opts?: pulumi.ComponentResourceOptions) {
    const certificate = args.acme.issueCertificate(`${name}-public`, {
      commonName: args.domain,
      subjectAlternativeNames: wildcardNodeCertNames(args.domain)
    });

    super(
      name,
      {
        fleet: args.fleet,
        nodes: args.nodes,
        domain: args.domain,
        dns: args.dns,
        addons: args.addons,
        rollout: args.rollout,
        app: context =>
          irohRelayApp({
            hostname: context.hostname,
            image: args.image,
            admissionUrl: args.admissionUrl,
            admissionToken: args.admissionToken,
            publicTls: certificate,
            ports: args.ports
          })
      },
      opts,
      'fleet:iroh:RelayWorkload',
      false
    );

    this.directory = buildIrohDirectory([...this.nodes.values()]);
    this.relayUrls = this.directory.apply(entries => entries.map(entry => entry.relayUrl));
    this.publicCertificateNotAfter = certificate.notAfter;
    this.registerOutputs({
      directory: this.directory,
      summary: this.summary,
      sshConfig: this.sshConfig,
      relayUrls: this.relayUrls,
      publicCertificateNotAfter: this.publicCertificateNotAfter
    });
  }
}
