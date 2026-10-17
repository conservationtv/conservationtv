import type { Database } from '../db/client.ts';
import { grants, irohLeases } from '../db/schema.ts';
import { useEnvironment } from '../env/env.ts';
import { newId } from '../ids.ts';
import { signMoqToken } from '../moq/tokens.ts';
import { type Grant, type IrohRequest, type MoqRequest, PROTOCOL_MAX_LIFETIME_SECONDS } from './grant.ts';

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
  grant: Grant;
  grantId: string;
  issuedAt: Date;
  expiresAt: Date;
}

const timestamp = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/, 'Z');

/** The lowest of the requested, environment and protocol lifetimes. */
const lifetimeSeconds = (grant: Grant) =>
  Math.min(grant.expires_in, useEnvironment().variables.MAX_CREDENTIAL_LIFETIME_SECONDS, PROTOCOL_MAX_LIFETIME_SECONDS);

async function leaseEndpoint(tx: Transaction, issuance: Issuance, iroh: IrohRequest): Promise<IrohCredential> {
  const leaseId = newId('irl', issuance.issuedAt.getTime());
  await tx.insert(irohLeases).values({
    id: leaseId,
    endpointId: iroh.endpoint_id,
    grantId: issuance.grantId,
    subject: issuance.grant.subject,
    expiresAt: issuance.expiresAt,
    createdAt: issuance.issuedAt
  });
  return { endpoint_id: iroh.endpoint_id, lease_id: leaseId, expires_at: timestamp(issuance.expiresAt) };
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

/** The grant audit record, the MoQ token and the Iroh lease succeed or fail together. */
export async function issueCredentials(grant: Grant): Promise<GrantExchangeResult> {
  const now = Math.floor(useEnvironment().clock() / 1000) * 1000;
  const issuedAt = new Date(now);
  const expiresAt = new Date(now + lifetimeSeconds(grant) * 1000);
  const issuance = { grant, grantId: newId('grt', now), issuedAt, expiresAt };
  const { moq, iroh } = grant.requested_capabilities;
  const db = await useEnvironment().database();
  return db.transaction(async tx => {
    // The audit record first, as the lease references it; each requested capability then adds its own credential.
    await tx.insert(grants).values({
      id: issuance.grantId,
      subject: grant.subject,
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
