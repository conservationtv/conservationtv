import { index, pgEnum, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

// Only relay state lives here: no application users, tenants, roles or permissions.

const instant = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/** One audit record per successful exchange. `grant_id` links the MoQ token and Iroh lease it produced. */
export const grants = pgTable(
  'grants',
  {
    id: text('id').primaryKey(),
    subject: text('subject').notNull(),
    moqRoot: text('moq_root'),
    moqPublish: text('moq_publish').array(),
    moqSubscribe: text('moq_subscribe').array(),
    irohEndpointId: text('iroh_endpoint_id'),
    issuedAt: instant('issued_at').notNull(),
    expiresAt: instant('expires_at').notNull(),
    revokedAt: instant('revoked_at')
  },
  table => [index().on(table.subject), index().on(table.issuedAt)]
);

export const irohLeaseStatus = pgEnum('iroh_lease_status', ['active', 'revoked']);

/** Short-lived admission state the Iroh relay's access callout checks. */
export const irohLeases = pgTable(
  'iroh_leases',
  {
    id: text('id').primaryKey(),
    endpointId: text('endpoint_id').notNull(),
    grantId: text('grant_id')
      .notNull()
      .references(() => grants.id),
    subject: text('subject').notNull(),
    expiresAt: instant('expires_at').notNull(),
    status: irohLeaseStatus('status').notNull().default('active'),
    createdAt: instant('created_at').notNull()
  },
  table => [index().on(table.endpointId, table.expiresAt), index().on(table.grantId)]
);
