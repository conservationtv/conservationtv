import { roleAssignments } from '@conservationtv/umbrella';
import type { Json } from '@conservationtv/versioned-api/server';
import { and, eq, gt, isNull, lte, or, sql } from 'drizzle-orm';
import { createMiddleware } from 'hono/factory';
import type { BlankEnv } from 'hono/types';
import { auditEntries } from '../db/schemas/audit.ts';
import { trustedTransaction, useDB } from '../db/transaction.ts';
import { useRequestRecord, type RequestFailureCode, type RequestRecord } from '../requests/record.ts';
import { organisationScope } from '../services/organisations.ts';
import { currentTraceId } from '../tracing/trace.ts';

// The audit log: an operation that is worth keeping says so where it is routed, with `audited(category)` after it
// authenticates, and is kept from what it did once it has been handled. Operations that change nothing anyone needs to
// know about later (people's own profiles, devices reporting, sessions and connections being opened) simply don't.
//
// An entry is kept for an operation that succeeded, and for one refused as `forbidden` to someone in the organisation
// (a member, or one of its devices), which is someone trying what they may not; not for anyone else's refusal, which
// would let any account write into an organisation's log, nor for any other failure, which changed nothing. It is written after the operation, in its own trusted
// transaction, before the response is sent. A failure to write it is logged rather than failing the request, whose
// change has already committed: the log can miss an entry, but never keeps one for a change that did not happen.

/** What kind of change an audited operation is: who may do what, credentials, or what the organisation runs. */
export type AuditCategory = 'access' | 'secrets' | 'configuration';

type NewAuditEntry = typeof auditEntries.$inferInsert;

/** A JSON body: an entry names its fields. */
type AuditedBody = Record<string, Json>;

/** What the validators after `audited` give it: the JSON body, when the operation takes one. */
interface AuditedOutput {
  json?: AuditedBody;
}

interface AuditedInput {
  out: AuditedOutput;
}

/** `succeeded`, `forbidden`, or undefined for an outcome not kept. */
function auditOutcome(status: number, failure: RequestFailureCode | undefined) {
  if (status < 400) return 'succeeded';
  if (failure === 'forbidden') return 'forbidden';
  return undefined;
}

/** The entry for a handled operation, from its record; undefined if it is not kept. */
function auditEntry(
  category: AuditCategory,
  record: RequestRecord,
  status: number,
  body: AuditedBody | undefined
): NewAuditEntry | undefined {
  const { operation, actor, organisationId, failure } = record;
  const outcome = auditOutcome(status, failure);
  if (!operation || !actor || !outcome) return undefined;
  // Every audited operation acts in an organisation; one that doesn't say which is a missing `recordOrganisation`.
  if (organisationId === undefined) {
    console.warn(JSON.stringify({ event: 'audit_without_organisation', operation: operation.id }));
    return undefined;
  }
  return {
    organisationId,
    operationId: operation.id,
    operationVersion: operation.version,
    category,
    outcome,
    actorKind: actor.principal.kind,
    actorId: String(actor.principal.id),
    sessionId: actor.sessionId,
    deviceKind: actor.deviceKind,
    targets: operation.targets,
    fields: Object.keys(body ?? {}),
    accessChanges: record.accessChanges.map(({ change, assignment }) => ({
      change,
      principalKind: assignment.principalKind,
      principalId: assignment.principalId,
      resource: assignment.resource,
      role: assignment.role,
      scopeName: assignment.scopeName,
      scopeId: assignment.scopeId
    })),
    traceId: currentTraceId()
  };
}

/** Whether the actor holds a role in effect at the entry's organisation: a member, or one of its devices. */
async function inOrganisation(entry: NewAuditEntry) {
  const db = useDB({ trusted: true });
  const scope = organisationScope(entry.organisationId);
  const now = sql`now()`;
  const [held] = await db
    .select({ id: roleAssignments.id })
    .from(roleAssignments)
    .where(
      and(
        eq(roleAssignments.principalKind, entry.actorKind),
        eq(roleAssignments.principalId, entry.actorId),
        eq(roleAssignments.scopeName, scope.name),
        eq(roleAssignments.scopeId, entry.organisationId),
        or(isNull(roleAssignments.startsAt), lte(roleAssignments.startsAt, now)),
        or(isNull(roleAssignments.expiresAt), gt(roleAssignments.expiresAt, now))
      )
    )
    .limit(1);
  return held !== undefined;
}

/** Keep `entry`; a refusal only when the actor is in the organisation (see the top of this file). */
async function insertAuditEntry(entry: NewAuditEntry) {
  if (entry.outcome === 'forbidden') {
    const inside = await inOrganisation(entry);
    if (!inside) return;
  }
  const db = useDB({ trusted: true });
  await db.insert(auditEntries).values(entry);
}

/**
 * Keep an entry for the operation once it has been handled. Placed after `requirePrincipal`: the entry is of who made
 * the request, where (the request record's organisation), to what (its path parameters), the fields its body set,
 * and the grants it changed. The error handler has rendered any failure by the time `next` returns, so the status is
 * the one sent.
 */
export function audited(category: AuditCategory) {
  return createMiddleware<BlankEnv, string, AuditedInput>(async (c, next) => {
    await next();
    const record = useRequestRecord();
    const validated = c.req.valid('json');
    // The keys the client sent, not the validated output's, which adds defaults. The validator read the body through
    // `c.req.json()`, and Hono caches its text, so this parses it again without reading the stream again.
    const body = validated === undefined ? undefined : await c.req.json<AuditedBody>();
    const entry = auditEntry(category, record, c.res.status, body);
    if (!entry) return;
    try {
      await trustedTransaction(() => insertAuditEntry(entry));
    } catch (error) {
      console.error(JSON.stringify({ event: 'audit_failed', operation: entry.operationId, cause: String(error) }));
    }
  });
}
