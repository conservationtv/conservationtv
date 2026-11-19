import { withAccess } from '@conservationtv/umbrella';
import { sql } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { organisationAdmin } from '../roles.ts';
import { organisations } from './organisations.ts';

/** A grant an audited operation stored or removed, as umbrella stores it. */
export interface AuditedAccessChange {
  change: 'granted' | 'revoked';
  principalKind: string;
  principalId: string;
  resource: string;
  role: string;
  scopeName: string;
  scopeId: string;
}

/**
 * What an organisation's people and devices did that is worth keeping: one entry for each audited operation
 * (`audited` in src/routes) that succeeded, or that was refused as `forbidden` to someone in the organisation. Written
 * by trusted code after the operation (src/audit/audit.ts), never by request sessions, and never changed: the
 * application role has `select` alone, and administrators read their organisation's entries. Like reports, entries
 * stay when their organisation is deleted.
 *
 * An entry names things by ID and changes by field name; it never holds what a field was set to, since bodies carry
 * stream keys and tokens.
 */
export const auditEntries = withAccess(
  pgTable(
    'audit_entry',
    {
      id: uuid('id')
        .primaryKey()
        .default(sql`uuidv7()`),
      organisationId: uuid('organisation_id')
        .notNull()
        .references(() => organisations.id),
      occurredAt: timestamp('occurred_at').defaultNow().notNull(),
      /** The operation, as the API names it: `organisations.members.grantAdmin`. */
      operationId: text('operation_id').notNull(),
      /** Absent for a versionless operation. */
      operationVersion: integer('operation_version'),
      /** What kind of change it is: access, secrets or configuration. */
      category: text('category').notNull(),
      /** `succeeded`, or `forbidden` when the actor, a member or device of the organisation, was refused. */
      outcome: text('outcome').notNull(),
      /** The umbrella principal that made the request: `user` or `device`, and its ID. */
      actorKind: text('actor_kind').notNull(),
      actorId: text('actor_id').notNull(),
      /** The sign-in session a user presented. Not a reference: it outlives the session. */
      sessionId: text('session_id'),
      /** The kind of the device that signed the request. */
      deviceKind: text('device_kind'),
      /** What the operation acted on: its path parameters besides the organisation, e.g. `{ "deviceId": "…" }`. */
      targets: jsonb('targets').$type<Record<string, string>>().default({}).notNull(),
      /** The fields a request body set, by name, without their values. */
      fields: text('fields').array().default([]).notNull(),
      /** The grants the operation stored or removed. */
      accessChanges: jsonb('access_changes').$type<AuditedAccessChange[]>().default([]).notNull(),
      /**
       * The request's trace (src/tracing/trace.ts), and the invocation's logs. The trace may not have been kept (sampled
       * out, or past retention); absent when the Worker's observability is off.
       */
      traceId: text('trace_id')
    },
    t => [index('audit_entry_organisation_occurred_idx').on(t.organisationId, t.occurredAt)]
  ),
  t => ({
    name: 'auditEntries',
    scope: organisations.$access.scope.via(t.organisationId),
    actions: { read: ['select'] },
    roles: {
      reader: {
        label: 'Audit reader',
        permissions: ['read'],
        assignableScopes: ['organisation'],
        includedIn: [organisationAdmin]
      }
    }
  })
);
