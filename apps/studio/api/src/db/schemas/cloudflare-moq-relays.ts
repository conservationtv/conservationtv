import { withAccess } from '@conservationtv/umbrella';
import { foreignKey, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { encrypted, Utf8Schema } from '../encrypted.ts';
import { gateways } from './gateways.ts';
import { organisations } from './organisations.ts';
import { observationAccess } from './report-access.ts';

/**
 * The Cloudflare MoQ relay a `cloudflare-moq` gateway is (src/gateways/cloudflare-moq.ts), made the first time anyone
 * connects to it, and the two tokens handed out for it: one that publishes and subscribes, for the devices publishing
 * to it, and one that only subscribes, for readers. Cloudflare shows a token's secret only when minting it, so the
 * secrets are kept here, encrypted, and only ever read by trusted code to hand to callers the provider admits. Each
 * is replaced when half its life is gone. The row goes with its gateway; the relay is deleted with it.
 */
export const cloudflareMoqRelays = withAccess(
  pgTable(
    'cloudflare_moq_relay',
    {
      organisationId: uuid('organisation_id')
        .notNull()
        .references(() => organisations.id, { onDelete: 'cascade' }),
      gatewayId: uuid('gateway_id').primaryKey(),
      /** The relay's `uid` at Cloudflare. */
      relayId: text('relay_id').notNull(),
      publishToken: encrypted('cloudflare_moq_relay.publish_token', Utf8Schema)('publish_token'),
      publishExpiresAt: timestamp('publish_expires_at'),
      subscribeToken: encrypted('cloudflare_moq_relay.subscribe_token', Utf8Schema)('subscribe_token'),
      subscribeExpiresAt: timestamp('subscribe_expires_at'),
      createdAt: timestamp('created_at').defaultNow().notNull()
    },
    t => [
      foreignKey({
        name: 'cloudflare_moq_relay_gateway_fk',
        columns: [t.organisationId, t.gatewayId],
        foreignColumns: [gateways.organisationId, gateways.id]
      }).onDelete('cascade')
    ]
  ),
  t => ({
    name: 'cloudflareMoqRelays',
    scope: organisations.$access.scope.via(t.organisationId),
    // Relay-wide credentials, handed only to callers the provider admits.
    hidden: [t.publishToken, t.subscribeToken],
    ...observationAccess
  })
);
