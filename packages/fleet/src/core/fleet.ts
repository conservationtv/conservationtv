import * as pulumi from '@pulumi/pulumi';
import * as tls from '@pulumi/tls';
import type { FleetContext, SshAccess } from './contracts';
import { resourceName } from './naming';
import { readSshAccess } from './validate';

export interface FleetArgs {
  /** Prefix for every cloud resource name and tag. */
  namePrefix: string;
  environment: string;
  ssh: SshAccess;
}

/**
 * Naming, SSH policy and the bootstrap SSH key shared by a set of machines.
 *
 * Machines take it as `fleet`; workloads never do, they only see machine outputs.
 */
export class Fleet extends pulumi.ComponentResource implements FleetContext {
  public readonly namePrefix: string;
  public readonly environment: string;
  public readonly ssh: SshAccess;
  public readonly publicKeyOpenSsh: pulumi.Output<string>;
  public readonly privateKeyPem: pulumi.Output<string>;

  public constructor(name: string, args: FleetArgs, opts?: pulumi.ComponentResourceOptions) {
    super('fleet:core:Fleet', name, {}, opts);
    this.namePrefix = resourceName(args.namePrefix);
    if (!this.namePrefix) throw new Error('Fleet namePrefix must contain at least one letter or number.');
    this.environment = resourceName(args.environment);
    if (!this.environment) throw new Error('Fleet environment must contain at least one letter or number.');
    this.ssh = readSshAccess(args.ssh);

    const key = new tls.PrivateKey(`${name}-bootstrap-ssh`, { algorithm: 'RSA', rsaBits: 4096 }, { parent: this });
    this.publicKeyOpenSsh = key.publicKeyOpenssh;
    this.privateKeyPem = pulumi.secret(key.privateKeyPem);

    this.registerOutputs({
      namePrefix: this.namePrefix,
      environment: this.environment,
      publicKeyOpenSsh: this.publicKeyOpenSsh,
      privateKeyPem: this.privateKeyPem
    });
  }
}
