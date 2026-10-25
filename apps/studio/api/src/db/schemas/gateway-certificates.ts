import { withAccess } from '@conservationtv/umbrella';
import { foreignKey, inet, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { encrypted, Utf8Schema } from '../encrypted.ts';
import { gateways } from './gateways.ts';
import { organisations } from './organisations.ts';
import { observationAccess } from './report-access.ts';

/**
 * The hostname a MediaMTX gateway is reached at on its network, and the certificate for it (src/gateways/certificates.ts):
 * `<gateway>.<organisation>.<GATEWAY_DOMAIN>`, chosen once from their names and kept, so renaming either changes
 * nothing. The private key is generated here, encrypted, and only ever read by trusted code to hand the agent running
 * the gateway. The certificate is absent until the authority issues one, and `error` says why the last attempt failed,
 * made at `attempted_at`, so attempts are spaced out. `address` is where the hostname's A record last pointed. The row
 * goes with its gateway.
 */
export const gatewayCertificates = withAccess(
  pgTable(
    'gateway_certificate',
    {
      organisationId: uuid('organisation_id')
        .notNull()
        .references(() => organisations.id, { onDelete: 'cascade' }),
      gatewayId: uuid('gateway_id').primaryKey(),
      hostname: text('hostname').notNull(),
      privateKey: encrypted('gateway_certificate.private_key', Utf8Schema)('private_key').notNull(),
      /** The PEM chain, the certificate first. */
      certificate: text('certificate'),
      notAfter: timestamp('not_after'),
      issuedAt: timestamp('issued_at'),
      attemptedAt: timestamp('attempted_at'),
      error: text('error'),
      address: inet('address'),
      createdAt: timestamp('created_at').defaultNow().notNull()
    },
    t => [
      unique('gateway_certificate_hostname').on(t.hostname),
      foreignKey({
        name: 'gateway_certificate_gateway_fk',
        columns: [t.organisationId, t.gatewayId],
        foreignColumns: [gateways.organisationId, gateways.id]
      }).onDelete('cascade')
    ]
  ),
  t => ({
    name: 'gatewayCertificates',
    scope: organisations.$access.scope.via(t.organisationId),
    // Generated here, handed only to the agent that runs the gateway.
    hidden: [t.privateKey],
    ...observationAccess
  })
);
