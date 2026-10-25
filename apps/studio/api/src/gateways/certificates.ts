import { parseStrictJson } from '@conservationtv/versioned-api/server';
import { eq, ne, and } from 'drizzle-orm';
import { gatewayCertificates } from '../db/schema.ts';
import { trustedTransaction, useDB } from '../db/transaction.ts';
import type { Variables } from '../env/config.ts';
import { useEnvironment } from '../env/env.ts';
import {
  AcmeAccountKeySchema,
  certificateNotAfter,
  generateCertificateKey,
  issueCertificate,
  type AcmeAuthority
} from './acme.ts';
import { upsertRecord, type DnsZone } from './dns.ts';

// A hostname for each MediaMTX gateway an agent runs, `<gateway>.<organisation>.<GATEWAY_DOMAIN>`, pointing at the
// agent on its network, with a certificate for it from an ACME authority (acme.ts), so readers and publishers on the
// network reach the gateway by name over TLS and browsers treat it as a secure origin. Public DNS, private address:
// Cloudflare serves the name (dns.ts) but never the traffic.
//
// It all happens while the agent asks for its configuration (src/configuration/plan/index.ts): the hostname is chosen
// the first time, the A record follows the agent's preferred address, and the certificate is issued when there is none
// and again within `RENEW_BEFORE_MS` of expiring, which makes that one ask slow by the tens of seconds the authority
// takes. That is rare, and the agent keeps serving what it had meanwhile. A failed attempt is not repeated for
// `RETRY_AFTER_MS`, so the authority's rate limits are respected and the next asks are quick. Nothing runs in the
// background, and nothing is checked between asks.

/** What issuing needs: the zone names are made in, and the authority that certifies them. */
export interface CertificateIssuer {
  domain: string;
  zone: DnsZone;
  authority: AcmeAuthority;
}

/** The issuer the deployment configures, or none without GATEWAY_DOMAIN; throws naming whatever else it then lacks. */
export function certificateIssuer(variables: Variables): CertificateIssuer | undefined {
  const domain = variables.GATEWAY_DOMAIN;
  if (domain === undefined) return undefined;
  const required = <Value>(name: string, value: Value | undefined): Value => {
    if (value === undefined) throw new Error(`${name} must be set when GATEWAY_DOMAIN is`);
    return value;
  };
  const accountKey = AcmeAccountKeySchema.parse(
    parseStrictJson(required('ACME_ACCOUNT_KEY', variables.ACME_ACCOUNT_KEY))
  );
  return {
    domain,
    zone: {
      zoneId: required('CLOUDFLARE_ZONE_ID', variables.CLOUDFLARE_ZONE_ID),
      token: required('CLOUDFLARE_API_TOKEN', variables.CLOUDFLARE_API_TOKEN)
    },
    authority: { directory: required('ACME_DIRECTORY_URL', variables.ACME_DIRECTORY_URL), accountKey }
  };
}

/** How long before a certificate expires it is renewed. */
export const RENEW_BEFORE_MS = 48 * 60 * 60_000;

/** How long after a failed attempt the next waits. */
export const RETRY_AFTER_MS = 10 * 60_000;

/** The longest a DNS label may be. */
const MAX_LABEL = 63;

/** The gateway a hostname and certificate are for, with the names its hostname is made from. */
export interface CertifiedGateway {
  id: string;
  organisationId: string;
  name: string;
  organisationName: string;
}

/** What the agent running the gateway serves TLS with. */
export interface GatewayTls {
  hostname: string;
  /** The PEM chain, the certificate first. */
  certificate: string;
  /** The PEM private key, PKCS#8. */
  privateKey: string;
  /** When the certificate expires, ISO 8601. */
  notAfter: string;
}

/** Records why the gateway has no hostname or certificate yet, or an out-of-date one. */
type Diagnose = (message: string) => void;

/** A DNS label from a name: its letters and digits, lowercase, runs of anything else as one hyphen. */
export function label(name: string, fallback: string): string {
  const slug = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, MAX_LABEL)
    .replace(/-+$/u, '');
  return slug === '' ? fallback : slug;
}

type CertificateRow = typeof gatewayCertificates.$inferSelect;

/** The hostname for the gateway: from the names, with the gateway's ID in it only if another gateway has that one. */
async function chooseHostname(gateway: CertifiedGateway, domain: string): Promise<string> {
  const db = useDB({ trusted: true });
  const organisation = label(gateway.organisationName, 'organisation');
  const plain = `${label(gateway.name, 'gateway')}.${organisation}.${domain}`;
  const [taken] = await db
    .select({ gatewayId: gatewayCertificates.gatewayId })
    .from(gatewayCertificates)
    .where(and(eq(gatewayCertificates.hostname, plain), ne(gatewayCertificates.gatewayId, gateway.id)));
  if (taken === undefined) return plain;
  const suffix = `-${gateway.id.replaceAll('-', '').slice(0, 8)}`;
  const distinct = `${label(gateway.name, 'gateway').slice(0, MAX_LABEL - suffix.length)}${suffix}`;
  return `${distinct}.${organisation}.${domain}`;
}

/** The gateway's row, made with a hostname and a fresh key the first time it is asked for. */
async function findOrCreate(gateway: CertifiedGateway, domain: string): Promise<CertificateRow> {
  const db = useDB({ trusted: true });
  const [existing] = await db.select().from(gatewayCertificates).where(eq(gatewayCertificates.gatewayId, gateway.id));
  if (existing !== undefined) return existing;
  const hostname = await chooseHostname(gateway, domain);
  const { privateKeyPem } = await generateCertificateKey();
  const [created] = await db
    .insert(gatewayCertificates)
    .values({ organisationId: gateway.organisationId, gatewayId: gateway.id, hostname, privateKey: privateKeyPem })
    .returning();
  return created!;
}

function update(gatewayId: string, changes: Partial<CertificateRow>) {
  return trustedTransaction(async () => {
    const db = useDB({ trusted: true });
    await db.update(gatewayCertificates).set(changes).where(eq(gatewayCertificates.gatewayId, gatewayId));
  });
}

/** Points the hostname at the address, when it does not already. Refusals are diagnosed, not thrown. */
async function pointAt(row: CertificateRow, address: string | undefined, zone: DnsZone, diagnose: Diagnose) {
  if (address === undefined) {
    diagnose(`${row.hostname} points nowhere yet: the agent has not reported a preferred address`);
    return;
  }
  if (row.address === address) return;
  try {
    await upsertRecord(zone, address.includes(':') ? 'AAAA' : 'A', row.hostname, address);
    await update(row.gatewayId, { address });
  } catch (error) {
    diagnose(`${row.hostname} could not be pointed at ${address}: ${String(error)}`);
  }
}

/** Whether the certificate is missing, or close enough to expiring to renew. */
function due(row: CertificateRow, now: number) {
  return row.certificate === null || row.notAfter === null || row.notAfter.getTime() - now < RENEW_BEFORE_MS;
}

/** Issues the certificate, or records why it could not be, diagnosed either way it fails. */
async function issue(row: CertificateRow, issuer: CertificateIssuer, now: number, diagnose: Diagnose) {
  const attemptedAt = new Date(now);
  try {
    const certificate = await issueCertificate(issuer.authority, issuer.zone, row.hostname, row.privateKey);
    const notAfter = certificateNotAfter(certificate);
    const changes = { certificate, notAfter, issuedAt: attemptedAt, attemptedAt, error: null };
    await update(row.gatewayId, changes);
    return { ...row, ...changes };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await update(row.gatewayId, { attemptedAt, error: message });
    diagnose(`No certificate could be issued for ${row.hostname}: ${message}`);
    return { ...row, attemptedAt, error: message };
  }
}

/**
 * The gateway's hostname, pointed at `address`, and a certificate for it, issued or renewed now if due and not just
 * tried. Undefined, with a diagnostic saying why, when the deployment issues none, or the gateway has no certificate
 * yet; one that is due but could not be renewed is returned as it is, since it still works until it expires.
 */
export async function ensureGatewayTls(
  gateway: CertifiedGateway,
  address: string | undefined,
  diagnose: Diagnose
): Promise<GatewayTls | undefined> {
  const environment = useEnvironment();
  const issuer = environment.gatewayCertificates;
  if (issuer === undefined) {
    diagnose('GATEWAY_DOMAIN is unset, so the gateway has no hostname or certificate');
    return undefined;
  }
  let row = await trustedTransaction(() => findOrCreate(gateway, issuer.domain));
  await pointAt(row, address, issuer.zone, diagnose);

  const now = environment.clock();
  if (due(row, now)) {
    const recently = row.attemptedAt !== null && now - row.attemptedAt.getTime() < RETRY_AFTER_MS;
    if (recently && row.error !== null)
      diagnose(`Issuing a certificate for ${row.hostname} is waiting to be retried: ${row.error}`);
    else row = await issue(row, issuer, now, diagnose);
  }
  if (row.certificate === null || row.notAfter === null) return undefined;
  return {
    hostname: row.hostname,
    certificate: row.certificate,
    privateKey: row.privateKey,
    notAfter: row.notAfter.toISOString()
  };
}
