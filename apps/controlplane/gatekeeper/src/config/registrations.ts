import type { ConsumerRegistrationInput } from './schemas.ts';

// Consumer registration is an administrative operation. Until there is an admin API, registrations and revocations are
// declared here as build defaults. CONSUMER_REGISTRATIONS and DENIED_IROH_ENDPOINTS environment bindings can replace
// these lists. The worker validates the complete configuration on first use; an invalid entry fails closed.
//
// Example:
//
//   {
//     principal_id: 'app-a-production',
//     authentication: {
//       method: 'federated_jwt',
//       issuer: 'https://api.app-a.example',
//       jwks_uri: 'https://api.app-a.example/.well-known/jwks.json',
//       audience: 'https://controlplane.example/grants/exchange',
//       subject: 'app-a-production',
//       allowed_algorithms: ['ES256'],
//       max_assertion_lifetime_seconds: 60,
//       denied_key_ids: []
//     },
//     delegation: {
//       subject_prefixes: ['app-a'],
//       moq: { roots: ['app-a'], actions: ['publish', 'subscribe'] },
//       iroh: { actions: ['connect'] },
//       max_credential_lifetime_seconds: 3600
//     },
//     enabled: true
//   }

export const consumerRegistrations: ConsumerRegistrationInput[] = [];

/** Iroh endpoint IDs that may never be admitted, regardless of the grant presented for them. */
export const deniedIrohEndpoints: string[] = [];
