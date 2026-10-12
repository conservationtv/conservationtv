import * as pulumi from '@pulumi/pulumi';
import * as tls from '@pulumi/tls';
import * as acme from '@pulumiverse/acme';
import type { PublicTlsMaterial } from '../contracts';
import { readHostname } from '../validate';

export interface AcmeAccountArgs {
  /** ACME directory URL, e.g. Let's Encrypt production or staging. */
  serverUrl: string;
  email?: string;
  dnsChallenge: AcmeDnsChallengeArgs;
}

export interface AcmeDnsChallengeArgs {
  provider: 'cloudflare';
  /** A Cloudflare token allowed to edit DNS in the zones being validated. */
  apiToken: pulumi.Input<string>;
}

/** An ACME registration plus the DNS-01 challenge every certificate issued under it uses. */
export class AcmeAccount extends pulumi.ComponentResource {
  /** Pass as `provider` to resources that talk to this ACME server. */
  public readonly provider: acme.Provider;
  public readonly accountKeyPem: pulumi.Output<string>;
  public readonly dnsChallenge: acme.types.input.CertificateDnsChallenge;

  public constructor(name: string, args: AcmeAccountArgs, opts?: pulumi.ComponentResourceOptions) {
    super('fleet:core:AcmeAccount', name, {}, opts);
    this.provider = new acme.Provider(`${name}-provider`, { serverUrl: args.serverUrl }, { parent: this });
    const accountKey = new tls.PrivateKey(
      `${name}-account-key`,
      { algorithm: 'ECDSA', ecdsaCurve: 'P256' },
      { parent: this }
    );
    const registration = new acme.Registration(
      `${name}-registration`,
      { accountKeyPem: accountKey.privateKeyPem, emailAddress: args.email },
      { parent: this, provider: this.provider }
    );
    this.accountKeyPem = registration.accountKeyPem;
    this.dnsChallenge = {
      provider: args.dnsChallenge.provider,
      config: { CLOUDFLARE_DNS_API_TOKEN: pulumi.secret(args.dnsChallenge.apiToken) }
    };
    this.registerOutputs({ registrationId: registration.id });
  }
}

export interface AcmeCertificateArgs {
  account: AcmeAccount;
  /** Hostnames to cover; the first is the common name. One leading `*.` label is allowed. */
  names: string[];
  /** Renew when fewer days than this remain. Defaults to 30. */
  minDaysRemaining?: number;
}

/** A DNS-01 validated certificate, renewed by `pulumi up` once it nears expiry. */
export class AcmeCertificate extends pulumi.ComponentResource implements PublicTlsMaterial {
  /** Leaf certificate followed by its issuer chain. */
  public readonly fullchainPem: pulumi.Output<string>;
  public readonly privateKeyPem: pulumi.Output<string>;
  public readonly notAfter: pulumi.Output<string>;

  public constructor(name: string, args: AcmeCertificateArgs, opts?: pulumi.ComponentResourceOptions) {
    super('fleet:core:AcmeCertificate', name, {}, opts);
    const [commonName, ...subjectAlternativeNames] = readCertificateNames(args.names);
    const certificate = new acme.Certificate(
      name,
      {
        accountKeyPem: args.account.accountKeyPem,
        commonName,
        subjectAlternativeNames,
        keyType: 'P256',
        minDaysRemaining: args.minDaysRemaining ?? 30,
        dnsChallenges: [args.account.dnsChallenge]
      },
      { parent: this, provider: args.account.provider }
    );
    this.fullchainPem = pulumi.interpolate`${certificate.certificatePem}${certificate.issuerPem}`;
    this.privateKeyPem = certificate.privateKeyPem;
    this.notAfter = certificate.certificateNotAfter;
    this.registerOutputs({ notAfter: this.notAfter });
  }
}

function readCertificateNames(names: string[]): string[] {
  if (names.length === 0) throw new Error('AcmeCertificate needs at least one name.');
  const normalized = [
    ...new Set(
      names.map((name, index) => {
        const what = `AcmeCertificate names[${index}]`;
        const wildcard = name.startsWith('*.');
        const hostname = readHostname(wildcard ? name.slice(2) : name, what);
        return wildcard ? `*.${hostname}` : hostname;
      })
    )
  ];
  // CAs reject a subject CN longer than the X.509 upper bound, even when it is a valid SAN.
  if (normalized[0].length > 64) {
    throw new Error(`AcmeCertificate common name "${normalized[0]}" exceeds 64 characters; list a shorter name first.`);
  }
  return normalized;
}
