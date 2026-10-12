import * as pulumi from '@pulumi/pulumi';
import * as tls from '@pulumi/tls';
import * as acme from '@pulumiverse/acme';

export interface PublicTlsMaterial {
  fullchainPem: pulumi.Output<string>;
  privateKeyPem: pulumi.Output<string>;
}

export interface AcmeIssuerArgs {
  serverUrl: string;
  email?: string;
  dnsChallenge: AcmeDnsChallengeArgs;
}

interface AcmeDnsChallengeArgs {
  provider: 'cloudflare';
  apiToken: pulumi.Input<string>;
}

export interface CertificateIssueArgs {
  commonName: string;
  subjectAlternativeNames?: string[];
  minDaysRemaining?: number;
}

export interface IssuedPublicTlsMaterial extends PublicTlsMaterial {
  notAfter: pulumi.Output<string>;
}

interface AcmeDnsChallenge {
  provider: 'cloudflare';
  config: AcmeDnsChallengeConfig;
}

interface AcmeDnsChallengeConfig {
  [key: string]: pulumi.Input<string>;
  CLOUDFLARE_DNS_API_TOKEN: pulumi.Output<string>;
}

export function wildcardNodeCertNames(domain: string): string[] {
  return [`nodes.${domain}`, `*.nodes.${domain}`];
}

export class AcmeIssuer extends pulumi.ComponentResource {
  private readonly provider: acme.Provider;
  private readonly registration: acme.Registration;

  public constructor(name: string, args: AcmeIssuerArgs, opts?: pulumi.ComponentResourceOptions) {
    super('fleet:core:AcmeIssuer', name, {}, opts);
    this.provider = new acme.Provider(`${name}-provider`, { serverUrl: args.serverUrl }, { parent: this });
    const accountKey = new tls.PrivateKey(
      `${name}-account-key`,
      {
        algorithm: 'ECDSA',
        ecdsaCurve: 'P256'
      },
      { parent: this }
    );
    this.registration = new acme.Registration(
      `${name}-registration`,
      {
        accountKeyPem: accountKey.privateKeyPem,
        emailAddress: args.email
      },
      { parent: this, provider: this.provider }
    );
    this.dnsChallenge = {
      provider: args.dnsChallenge.provider,
      config: { CLOUDFLARE_DNS_API_TOKEN: pulumi.secret(args.dnsChallenge.apiToken) }
    };
    this.registerOutputs();
  }

  private readonly dnsChallenge: AcmeDnsChallenge;

  public issueCertificate(
    name: string,
    args: CertificateIssueArgs,
    opts?: pulumi.CustomResourceOptions
  ): IssuedPublicTlsMaterial {
    const certificate = new acme.Certificate(
      name,
      {
        accountKeyPem: this.registration.accountKeyPem,
        commonName: args.commonName,
        subjectAlternativeNames: args.subjectAlternativeNames,
        keyType: 'P256',
        minDaysRemaining: args.minDaysRemaining ?? 30,
        dnsChallenges: [this.dnsChallenge]
      },
      { ...opts, parent: opts?.parent ?? this, provider: this.provider }
    );
    return {
      fullchainPem: pulumi.interpolate`${certificate.certificatePem}${certificate.issuerPem}`,
      privateKeyPem: certificate.privateKeyPem,
      notAfter: certificate.certificateNotAfter
    };
  }
}
