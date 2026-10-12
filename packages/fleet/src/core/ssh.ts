import * as pulumi from '@pulumi/pulumi';
import * as tls from '@pulumi/tls';

export interface SshPublicKeyMaterial {
  publicKeyOpenSsh: pulumi.Output<string>;
  privateKeyPem: pulumi.Output<string>;
}

export class BootstrapSshKey extends pulumi.ComponentResource implements SshPublicKeyMaterial {
  public readonly publicKeyOpenSsh: pulumi.Output<string>;
  public readonly privateKeyPem: pulumi.Output<string>;

  public constructor(name: string, opts?: pulumi.ComponentResourceOptions) {
    super('fleet:core:BootstrapSshKey', name, {}, opts);
    const key = new tls.PrivateKey(`${name}-key`, { algorithm: 'RSA', rsaBits: 4096 }, { parent: this });
    this.publicKeyOpenSsh = key.publicKeyOpenssh;
    this.privateKeyPem = pulumi.secret(key.privateKeyPem);
    this.registerOutputs({ publicKeyOpenSsh: this.publicKeyOpenSsh, privateKeyPem: this.privateKeyPem });
  }
}
