import { index, jsonb, pgEnum, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

// Only generic trust and relay state lives here: no application users, tenants, roles or permissions.

const instant = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/** Consumed grant assertion identifiers, kept until the assertion could no longer be accepted anyway. */
export const assertionReplays = pgTable(
  'assertion_replays',
  {
    principalId: text('principal_id').notNull(),
    jti: text('jti').notNull(),
    expiresAt: instant('expires_at').notNull()
  },
  table => [primaryKey({ columns: [table.principalId, table.jti] }), index().on(table.expiresAt)]
);

/** One audit record per successful exchange. `grant_id` links the MoQ token and Iroh lease it produced. */
export const grants = pgTable(
  'grants',
  {
    id: text('id').primaryKey(),
    principalId: text('principal_id').notNull(),
    subject: text('subject').notNull(),
    assertionJti: text('assertion_jti').notNull(),
    assertionKeyId: text('assertion_key_id').notNull(),
    moqRoot: text('moq_root'),
    moqPublish: text('moq_publish').array(),
    moqSubscribe: text('moq_subscribe').array(),
    irohEndpointId: text('iroh_endpoint_id'),
    issuedAt: instant('issued_at').notNull(),
    expiresAt: instant('expires_at').notNull(),
    revokedAt: instant('revoked_at')
  },
  table => [index().on(table.principalId, table.subject), index().on(table.issuedAt)]
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
    principalId: text('principal_id').notNull(),
    subject: text('subject').notNull(),
    expiresAt: instant('expires_at').notNull(),
    status: irohLeaseStatus('status').notNull().default('active'),
    createdAt: instant('created_at').notNull()
  },
  table => [index().on(table.endpointId, table.expiresAt), index().on(table.grantId)]
);

/** Consumer JWKS documents, persisted so isolates can share them and keep using them through short outages. */
export const jwksCache = pgTable('jwks_cache', {
  jwksUri: text('jwks_uri').primaryKey(),
  keys: jsonb('keys').notNull(),
  fetchedAt: instant('fetched_at').notNull(),
  freshUntil: instant('fresh_until').notNull(),
  staleUntil: instant('stale_until').notNull()
});
