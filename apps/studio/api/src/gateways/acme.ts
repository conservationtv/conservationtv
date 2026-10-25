import { Attributes, CertificationRequest, CertificationRequestInfo } from '@peculiar/asn1-csr';
import { ECDSASigValue } from '@peculiar/asn1-ecc';
import { AsnConvert, OctetString } from '@peculiar/asn1-schema';
import {
  AlgorithmIdentifier,
  Attribute,
  AttributeTypeAndValue,
  AttributeValue,
  Certificate,
  Extension,
  Extensions,
  GeneralName,
  Name,
  RelativeDistinguishedName,
  SubjectAlternativeName,
  SubjectPublicKeyInfo
} from '@peculiar/asn1-x509';
import { calculateJwkThumbprint, FlattenedSign, importJWK, type JWK } from 'jose';
import { z } from 'zod';
import { ApiFailure } from '../errors.ts';
import { createRecord, type DnsZone } from './dns.ts';

// Certificates from an ACME certificate authority (RFC 8555), Let's Encrypt by default, for one hostname at a time,
// proving control of it by DNS-01: the challenge's token goes in a TXT record at `_acme-challenge.<hostname>` in the
// zone this API manages (src/gateways/dns.ts), which the authority looks up. Only the parts of the protocol that takes
// are here: an account from the configured key (the authority returns the existing account for a known key, so
// nothing is stored), an order for the name, its one authorization's DNS-01 challenge, finalization with a CSR, and
// the certificate chain. Everything the authority refuses is `gateway_unavailable`, with its problem detail.
//
// Issuance waits on the authority, which waits on DNS, so it takes tens of seconds. The caller decides when that is
// acceptable.

/** The account key, as the ACME_ACCOUNT_KEY secret holds it: one ES256 JWK with its private `d`. */
export const AcmeAccountKeySchema = z.strictObject({
  kty: z.literal('EC'),
  crv: z.literal('P-256'),
  x: z.string(),
  y: z.string(),
  d: z.string()
});
export type AcmeAccountKey = z.output<typeof AcmeAccountKeySchema>;

export interface AcmeAuthority {
  /** The directory URL, such as Let's Encrypt's `https://acme-v02.api.letsencrypt.org/directory`. */
  directory: string;
  accountKey: AcmeAccountKey;
}

/** How often the authority is asked whether it has validated or issued, and how many times before giving up. */
const POLL_INTERVAL_MS = 2_000;
const POLL_ATTEMPTS = 45;

const DirectorySchema = z.object({ newNonce: z.url(), newAccount: z.url(), newOrder: z.url() });
type Directory = z.output<typeof DirectorySchema>;

const ChallengeSchema = z.object({
  type: z.string(),
  url: z.url(),
  token: z.string(),
  status: z.string(),
  error: z.object({ detail: z.string().optional() }).optional()
});
type Challenge = z.output<typeof ChallengeSchema>;

const AuthorizationSchema = z.object({ status: z.string(), challenges: z.array(ChallengeSchema) });
type Authorization = z.output<typeof AuthorizationSchema>;

const OrderSchema = z.object({
  status: z.string(),
  authorizations: z.array(z.url()),
  finalize: z.url(),
  certificate: z.url().optional(),
  error: z.object({ detail: z.string().optional() }).optional()
});
type Order = z.output<typeof OrderSchema>;

const ProblemSchema = z.object({ type: z.string().optional(), detail: z.string().optional() });
type Problem = z.output<typeof ProblemSchema>;

/** Registering the account: the authority's terms are agreed to. */
interface NewAccount {
  termsOfServiceAgreed: true;
}

/** A name to certify. */
interface DnsIdentifier {
  type: 'dns';
  value: string;
}

/** Ordering a certificate for the names. */
interface NewOrder {
  identifiers: DnsIdentifier[];
}

/** Finalizing the order with the request for the certificate, as base64url DER. */
interface Finalization {
  csr: string;
}

/** Responding to a challenge: an empty object (RFC 8555 §7.5.1). */
type ChallengeResponse = Record<string, never>;

/** The body of a request to the authority, as JSON. */
type AcmeRequest = NewAccount | NewOrder | Finalization | ChallengeResponse;

const refused = (what: string, detail: string) =>
  new ApiFailure('gateway_unavailable', { cause: `The certificate authority refused ${what}: ${detail}` });

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Why an authorization was not validated: its DNS-01 challenge's own error when it gives one, else its status. */
const challengeFailure = (authorization: Authorization) => {
  const failed: Challenge | undefined = authorization.challenges.find(candidate => candidate.type === 'dns-01');
  return failed?.error?.detail ?? `authorization ${authorization.status}`;
};

const base64url = (bytes: ArrayBuffer | Uint8Array) =>
  Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString('base64url');

/** A key pair for a certificate: ECDSA P-256, as MediaMTX and every client accept. */
export async function generateCertificateKey() {
  const algorithm = { name: 'ECDSA', namedCurve: 'P-256' };
  // SAFETY: generating an ECDSA key yields a pair.
  const keys = (await crypto.subtle.generateKey(algorithm, true, ['sign', 'verify'])) as CryptoKeyPair;
  // SAFETY: exporting a private key as PKCS#8 yields DER bytes, not a JWK.
  const pkcs8 = (await crypto.subtle.exportKey('pkcs8', keys.privateKey)) as ArrayBuffer;
  return { keys, privateKeyPem: pem('PRIVATE KEY', pkcs8) };
}

/** The key pair a PKCS#8 PEM holds, to request a certificate for it again. */
async function importCertificateKey(privateKeyPem: string): Promise<CryptoKeyPair> {
  const algorithm = { name: 'ECDSA', namedCurve: 'P-256' };
  const privateKey = await crypto.subtle.importKey('pkcs8', der(privateKeyPem), algorithm, true, ['sign']);
  // The public half, through the JWK the private key exports as.
  // SAFETY: exporting as `jwk` yields a JWK, not bytes.
  const { d: _d, ...publicJwk } = (await crypto.subtle.exportKey('jwk', privateKey)) as JsonWebKey;
  const publicKey = await crypto.subtle.importKey('jwk', publicJwk, algorithm, true, ['verify']);
  return { privateKey, publicKey };
}

function pem(label: string, der: ArrayBuffer) {
  const lines =
    Buffer.from(der)
      .toString('base64')
      .match(/.{1,64}/gu) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

/** The DER a PEM block holds. */
function der(pemBlock: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(Buffer.from(pemBlock.replace(/-----[A-Z ]+-----|\s/gu, ''), 'base64'));
}

/** When the first certificate of a PEM chain expires. */
export function certificateNotAfter(chainPem: string): Date {
  const [first] = chainPem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/u) ?? [];
  if (first === undefined) throw new Error('The certificate chain has no certificate');
  return AsnConvert.parse(der(first), Certificate).tbsCertificate.validity.notAfter.getTime();
}

// Object identifiers the request is made of.
const OID = {
  commonName: '2.5.4.3',
  subjectAltName: '2.5.29.17',
  extensionRequest: '1.2.840.113549.1.9.14',
  ecdsaWithSha256: '1.2.840.10045.4.3.2'
};

/** An ASN.1 INTEGER's bytes from an unsigned big-endian number: no leading zeros, and a zero byte if the top bit is set. */
function integer(unsigned: Uint8Array): ArrayBuffer {
  let start = 0;
  while (start < unsigned.length - 1 && unsigned[start] === 0) start++;
  const magnitude = unsigned.subarray(start);
  const padded = magnitude[0]! & 0x80 ? Buffer.concat([Buffer.of(0), magnitude]) : Buffer.from(magnitude);
  return padded.buffer.slice(padded.byteOffset, padded.byteOffset + padded.byteLength);
}

/**
 * A PKCS#10 request for a certificate naming `hostname`, as its common name and its one subject alternative name,
 * for `keys`, signed by them with ECDSA over SHA-256: the DER.
 */
export async function certificateRequest(hostname: string, keys: CryptoKeyPair): Promise<ArrayBuffer> {
  // SAFETY: exporting a public key as SPKI yields DER bytes, not a JWK.
  const spki = (await crypto.subtle.exportKey('spki', keys.publicKey)) as ArrayBuffer;
  const subjectAltName = new SubjectAlternativeName([new GeneralName({ dNSName: hostname })]);
  const extensions = new Extensions([
    new Extension({
      extnID: OID.subjectAltName,
      critical: false,
      extnValue: new OctetString(AsnConvert.serialize(subjectAltName))
    })
  ]);
  const info = new CertificationRequestInfo({
    version: 0,
    subject: new Name([
      new RelativeDistinguishedName([
        new AttributeTypeAndValue({ type: OID.commonName, value: new AttributeValue({ utf8String: hostname }) })
      ])
    ]),
    subjectPKInfo: AsnConvert.parse(spki, SubjectPublicKeyInfo),
    attributes: new Attributes([
      new Attribute({ type: OID.extensionRequest, values: [AsnConvert.serialize(extensions)] })
    ])
  });
  const tbs = AsnConvert.serialize(info);
  // WebCrypto's ECDSA signature is r and s, 32 bytes each; X.509 carries them as a SEQUENCE of two INTEGERs.
  const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, tbs));
  const half = raw.length / 2;
  const signature = new ECDSASigValue({ r: integer(raw.subarray(0, half)), s: integer(raw.subarray(half)) });
  const request = new CertificationRequest({
    certificationRequestInfo: info,
    signatureAlgorithm: new AlgorithmIdentifier({ algorithm: OID.ecdsaWithSha256 }),
    signature: AsnConvert.serialize(signature)
  });
  return AsnConvert.serialize(request);
}

/** Why the authority refused a request: the problem type it named, if any, and the failure to throw for it. */
interface Refusal {
  type: string | undefined;
  error: ApiFailure;
}

/** One session with the authority: its directory, the account's key, and the nonce it last gave. */
class AcmeSession {
  private nonce: string | undefined = undefined;
  private kid: string | undefined = undefined;

  private constructor(
    private readonly directory: Directory,
    private readonly key: CryptoKey,
    private readonly publicJwk: JWK
  ) {}

  static async open(authority: AcmeAuthority): Promise<AcmeSession> {
    const response = await fetch(authority.directory);
    if (!response.ok) throw refused('its directory', `${response.status} ${response.statusText}`);
    const directory = DirectorySchema.parse(await response.json());
    const { d: _d, ...publicJwk } = authority.accountKey;
    const key = await importJWK(authority.accountKey, 'ES256');
    // SAFETY: importing a private JWK yields a CryptoKey; only a public JWK could import as bytes.
    const session = new AcmeSession(directory, key as CryptoKey, publicJwk);
    await session.register();
    return session;
  }

  /** The account for the key: created, or the existing one, whose URL signs everything after. */
  private async register() {
    const response = await this.post(this.directory.newAccount, { termsOfServiceAgreed: true });
    const location = response.headers.get('location');
    if (location === null) throw refused('the account', 'no account URL was returned');
    this.kid = location;
  }

  /** The DNS-01 key authorization's TXT value for a challenge token. */
  private async txtValue(token: string) {
    const thumbprint = await calculateJwkThumbprint(this.publicJwk, 'sha256');
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${token}.${thumbprint}`));
    return base64url(digest);
  }

  private async freshNonce(): Promise<string> {
    const response = await fetch(this.directory.newNonce, { method: 'HEAD' });
    const nonce = response.headers.get('replay-nonce');
    if (nonce === null) throw refused('a nonce', 'none was returned');
    return nonce;
  }

  /** The request as the authority takes it: a JWS by the account key, named by its URL once there is one, before by the key. */
  private async sign(url: string, nonce: string, payload: AcmeRequest | undefined): Promise<string> {
    const identity = this.kid === undefined ? { jwk: this.publicJwk } : { kid: this.kid };
    const header = { alg: 'ES256', nonce, url, ...identity };
    const body = payload === undefined ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(payload));
    const jws = await new FlattenedSign(body).setProtectedHeader(header).sign(this.key);
    return JSON.stringify(jws);
  }

  /** The authority's refusal: its problem document's detail, or type, or the status line. */
  private async refusal(url: string, response: Response): Promise<Refusal> {
    const parsed = ProblemSchema.safeParse(await response.json().catch(() => undefined));
    const problem: Problem | undefined = parsed.success ? parsed.data : undefined;
    const detail = problem?.detail ?? problem?.type ?? `${response.status} ${response.statusText}`;
    return { type: problem?.type, error: refused(url, detail) };
  }

  /**
   * A signed request: `payload` as JSON, or none for POST-as-GET. Signed by the account key, with the nonce the last
   * response gave or a fresh one. A nonce the authority finds stale is retried once with a fresh one.
   */
  private async post(url: string, payload?: AcmeRequest, retried = false): Promise<Response> {
    const nonce = this.nonce ?? (await this.freshNonce());
    this.nonce = undefined;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/jose+json' },
      body: await this.sign(url, nonce, payload)
    });
    this.nonce = response.headers.get('replay-nonce') ?? undefined;
    if (response.ok) return response;
    const { type, error } = await this.refusal(url, response);
    if (type === 'urn:ietf:params:acme:error:badNonce' && !retried) return this.post(url, payload, true);
    throw error;
  }

  private async read<Schema extends z.ZodType>(url: string, schema: Schema): Promise<z.output<Schema>> {
    const response = await this.post(url);
    return schema.parse(await response.json());
  }

  /** Asks until `done` says so, or the attempts run out. */
  private async poll<Schema extends z.ZodType>(
    url: string,
    schema: Schema,
    done: (value: z.output<Schema>) => boolean
  ) {
    for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
      const value = await this.read(url, schema);
      if (done(value)) return value;
      await sleep(POLL_INTERVAL_MS);
    }
    throw refused(url, 'it did not finish in time');
  }

  /**
   * Proves control of `hostname` for one authorization of an order, unless it is already valid from an earlier order:
   * publishes the DNS-01 token in `zone`, tells the authority to look, waits until it has decided, and takes the token
   * down whatever it decided. Throws the authority's refusal.
   */
  private async authorize(authorizationUrl: string, hostname: string, zone: DnsZone): Promise<void> {
    const authorization = await this.read(authorizationUrl, AuthorizationSchema);
    if (authorization.status === 'valid') return;
    const challenge = authorization.challenges.find(candidate => candidate.type === 'dns-01');
    if (challenge === undefined) throw refused('the authorization', 'it offers no dns-01 challenge');
    const remove = await createRecord(zone, 'TXT', `_acme-challenge.${hostname}`, await this.txtValue(challenge.token));
    try {
      await this.post(challenge.url, {});
      const validated = await this.poll(authorizationUrl, AuthorizationSchema, result => result.status !== 'pending');
      if (validated.status !== 'valid') throw refused(`the challenge for ${hostname}`, challengeFailure(validated));
    } finally {
      await remove().catch(() => undefined);
    }
  }

  /** Finalizes the order with a request for `hostname` and `keys`, and waits for the certificate: its URL. */
  private async finalize(order: Order, orderUrl: string, hostname: string, keys: CryptoKeyPair): Promise<string> {
    const csr = await certificateRequest(hostname, keys);
    await this.post(order.finalize, { csr: base64url(csr) });
    const settled = (result: Order) => result.status !== 'processing' && result.status !== 'ready';
    const issued = await this.poll(orderUrl, OrderSchema, settled);
    if (issued.status !== 'valid' || issued.certificate === undefined) {
      throw refused('the order', issued.error?.detail ?? `order ${issued.status}`);
    }
    return issued.certificate;
  }

  /**
   * A certificate for `hostname` and `keys`, proving control of it by a TXT record in `zone`. Resolves to the PEM
   * chain, the certificate first.
   */
  async issue(hostname: string, keys: CryptoKeyPair, zone: DnsZone): Promise<string> {
    const ordered = await this.post(this.directory.newOrder, { identifiers: [{ type: 'dns', value: hostname }] });
    const orderUrl = ordered.headers.get('location');
    if (orderUrl === null) throw refused('the order', 'no order URL was returned');
    const order = OrderSchema.parse(await ordered.json());
    for (const authorizationUrl of order.authorizations) await this.authorize(authorizationUrl, hostname, zone);
    const certificateUrl = await this.finalize(order, orderUrl, hostname, keys);
    const certificate = await this.post(certificateUrl);
    return certificate.text();
  }
}

/** A certificate for `hostname`, from the authority, for the key the PEM holds: the chain, the certificate first. */
export async function issueCertificate(
  authority: AcmeAuthority,
  zone: DnsZone,
  hostname: string,
  privateKeyPem: string
): Promise<string> {
  const session = await AcmeSession.open(authority);
  const keys = await importCertificateKey(privateKeyPem);
  return session.issue(hostname, keys, zone);
}
