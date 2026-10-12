import { and, eq, gt, ne, sql } from 'drizzle-orm';
import type { ConsumerRegistration } from '../config/schemas.ts';
import type { Database } from '../db/client.ts';
import { assertionReplays, grants, irohLeases } from '../db/schema.ts';
import { GrantError } from '../errors.ts';
import { newId } from '../ids.ts';
import { signMoqToken } from '../moq/tokens.ts';
import { services } from '../services.ts';
import type { VerifiedAssertion } from './assertion.ts';
import { effectiveLifetimeSeconds } from './delegation.ts';
import type { GrantV1, IrohRequest, MoqRequest } from './grant.ts';

export interface MoqCredential {
  root: string;
  /** A control-plane-signed moq-relay token. Treat it as a secret. */
  token: string;
  expires_at: string;
}

export interface IrohCredential {
  endpoint_id: string;
  lease_id: string;
  expires_at: string;
}

export interface Credentials {
  moq?: MoqCredential;
  iroh?: IrohCredential;
}

export interface GrantExchangeResult {
  grant_id: string;
  subject: string;
  issued_at: string;
  expires_at: string;
  credentials: Credentials;
}

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

interface Issuance {
  registration: ConsumerRegistration;
  assertion: VerifiedAssertion;
  grant: GrantV1;
  grantId: string;
  issuedAt: Date;
  expiresAt: Date;
}

const timestamp = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/, 'Z');

/** Consume the assertion's `jti`. A second exchange of the same assertion finds the row and is refused. */
async function consumeAssertion(tx: Transaction, issuance: Issuance) {
  const { claims } = issuance.assertion;
  const skew = services().policy.clockSkewSeconds;
  const consumed = await tx
    .insert(assertionReplays)
    .values({
      principalId: issuance.registration.principal_id,
      jti: claims.jti,
      expiresAt: new Date((claims.exp + skew) * 1000)
    })
    .onConflictDoNothing()
    .returning({ jti: assertionReplays.jti });
  if (consumed.length === 0) throw new GrantError('assertion_replayed');
}

/** An endpoint actively leased to another consumer can't be leased again until that lease ends. */
async function leaseEndpoint(tx: Transaction, issuance: Issuance, iroh: IrohRequest): Promise<IrohCredential> {
  const { registration, grantId, issuedAt, expiresAt, grant } = issuance;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${iroh.endpoint_id}, 0))`);
  const [conflict] = await tx
    .select({ id: irohLeases.id })
    .from(irohLeases)
    .where(
      and(
        eq(irohLeases.endpointId, iroh.endpoint_id),
        eq(irohLeases.status, 'active'),
        gt(irohLeases.expiresAt, issuedAt),
        ne(irohLeases.principalId, registration.principal_id)
      )
    )
    .limit(1);
  if (conflict) throw new GrantError('invalid_endpoint_id');
  const leaseId = newId('irl', issuedAt.getTime());
  await tx.insert(irohLeases).values({
    id: leaseId,
    endpointId: iroh.endpoint_id,
    grantId,
    principalId: registration.principal_id,
    subject: grant.subject,
    expiresAt,
    createdAt: issuedAt
  });
  return { endpoint_id: iroh.endpoint_id, lease_id: leaseId, expires_at: timestamp(expiresAt) };
}

async function moqCredential(issuance: Issuance, moq: MoqRequest): Promise<MoqCredential> {
  const token = await signMoqToken({
    grantId: issuance.grantId,
    root: moq.root,
    publish: moq.publish,
    subscribe: moq.subscribe,
    issuedAt: issuance.issuedAt.getTime() / 1000,
    expiresAt: issuance.expiresAt.getTime() / 1000
  });
  return { root: moq.root, token, expires_at: timestamp(issuance.expiresAt) };
}

/**
 * Step 9. Replay consumption, the grant audit record, the MoQ token and the Iroh lease succeed or fail together: a
 * rejection anywhere leaves no record and no consumed `jti`.
 */
export async function issueCredentials(
  registration: ConsumerRegistration,
  assertion: VerifiedAssertion,
  grant: GrantV1
): Promise<GrantExchangeResult> {
  const now = Math.floor(services().clock() / 1000) * 1000;
  const issuedAt = new Date(now);
  const expiresAt = new Date(now + effectiveLifetimeSeconds(registration, grant, services().policy) * 1000);
  const issuance = { registration, assertion, grant, grantId: newId('grt', now), issuedAt, expiresAt };
  const { moq, iroh } = grant.requested_capabilities;
  const db = await services().database();
  return db.transaction(async tx => {
    // Consume first so a replay fails before any other write; each requested capability adds its own credential.
    await consumeAssertion(tx, issuance);
    await tx.insert(grants).values({
      id: issuance.grantId,
      principalId: registration.principal_id,
      subject: grant.subject,
      assertionJti: assertion.claims.jti,
      assertionKeyId: assertion.keyId,
      moqRoot: moq?.root,
      moqPublish: moq?.publish,
      moqSubscribe: moq?.subscribe,
      irohEndpointId: iroh?.endpoint_id,
      issuedAt,
      expiresAt
    });
    const credentials: Credentials = {};
    if (moq) credentials.moq = await moqCredential(issuance, moq);
    if (iroh) credentials.iroh = await leaseEndpoint(tx, issuance, iroh);
    return {
      grant_id: issuance.grantId,
      subject: grant.subject,
      issued_at: timestamp(issuedAt),
      expires_at: timestamp(expiresAt),
      credentials
    };
  });
}
