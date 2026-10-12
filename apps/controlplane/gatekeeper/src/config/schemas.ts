import { z } from 'zod';
import { EndpointIdSchema, MoqPathSchema, SubjectPrefixSchema } from '../grants/identifiers.ts';

export const GRANT_ASSERTION_TYPE = 'relay-grant+jwt';

/** Asymmetric algorithms a consumer may register. `none` and shared-secret algorithms are never accepted. */
export const AssertionAlgorithmSchema = z.enum(['ES256', 'ES384', 'EdDSA', 'RS256', 'PS256']);
export type AssertionAlgorithm = z.output<typeof AssertionAlgorithmSchema>;

const PROHIBITED_HOST = /^(localhost|.*\.localhost|.*\.local|.*\.internal|\[.*\]|\d{1,3}(\.\d{1,3}){3})$/i;

/**
 * Consumer JWKS locations are fixed by registration. They must be HTTPS on a public DNS name: IP literals and local
 * names are refused so a registration can't point the fetcher at internal infrastructure.
 */
export const JwksUriSchema = z.url({ protocol: /^https$/, hostname: z.regexes.domain }).refine(value => {
  const url = new URL(value);
  return !url.username && !url.password && !url.hash && !PROHIBITED_HOST.test(url.hostname);
}, 'JWKS URIs must be HTTPS URLs on a public DNS name without credentials or fragments');
export type JwksUri = z.output<typeof JwksUriSchema>;

const AuthenticationSchema = z.strictObject({
  method: z.literal('federated_jwt'),
  issuer: z.url({ protocol: /^https$/ }),
  jwks_uri: JwksUriSchema,
  audience: z.url({ protocol: /^https$/ }),
  subject: z.string().min(1).max(256),
  allowed_algorithms: z.array(AssertionAlgorithmSchema).nonempty(),
  max_assertion_lifetime_seconds: z.int().min(1).max(300),
  token_type: z.literal(GRANT_ASSERTION_TYPE).default(GRANT_ASSERTION_TYPE),
  /** Key IDs revoked in the control plane, effective before the consumer's own JWKS stops publishing them. */
  denied_key_ids: z.array(z.string().min(1)).default([])
});
export type Authentication = z.output<typeof AuthenticationSchema>;

const MoqDelegationSchema = z.strictObject({
  roots: z.array(MoqPathSchema).nonempty(),
  actions: z.array(z.enum(['publish', 'subscribe'])).nonempty()
});
export type MoqDelegation = z.output<typeof MoqDelegationSchema>;

const IrohDelegationSchema = z.strictObject({
  actions: z.array(z.literal('connect')).nonempty()
});
export type IrohDelegation = z.output<typeof IrohDelegationSchema>;

/** The most authority a consumer may delegate. Requests may narrow it, never expand it. */
const DelegationSchema = z.strictObject({
  subject_prefixes: z.array(SubjectPrefixSchema).nonempty(),
  moq: MoqDelegationSchema.optional(),
  iroh: IrohDelegationSchema.optional(),
  max_credential_lifetime_seconds: z.int().min(1).max(86_400)
});
export type Delegation = z.output<typeof DelegationSchema>;

export const ConsumerRegistrationSchema = z.strictObject({
  principal_id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  authentication: AuthenticationSchema,
  delegation: DelegationSchema,
  enabled: z.boolean()
});
export type ConsumerRegistration = z.output<typeof ConsumerRegistrationSchema>;
export type ConsumerRegistrationInput = z.input<typeof ConsumerRegistrationSchema>;

/** Registrations must be unambiguous: one principal per ID and one per issuer/subject pair. */
export const ConsumerRegistrationsSchema = z.array(ConsumerRegistrationSchema).superRefine((registrations, context) => {
  const principals = new Set<string>();
  const identities = new Set<string>();
  for (const registration of registrations) {
    const identity = JSON.stringify([registration.authentication.issuer, registration.authentication.subject]);
    if (principals.has(registration.principal_id) || identities.has(identity)) {
      context.addIssue({ code: 'custom', message: `Duplicate consumer registration: ${registration.principal_id}` });
    }
    principals.add(registration.principal_id);
    identities.add(identity);
  }
});
export type ConsumerRegistrations = z.output<typeof ConsumerRegistrationsSchema>;

export const DeniedEndpointsSchema = z.array(EndpointIdSchema);
export type DeniedEndpoints = z.output<typeof DeniedEndpointsSchema>;

export const PolicyConfigSchema = z.strictObject({
  consumers: ConsumerRegistrationsSchema,
  deniedIrohEndpoints: DeniedEndpointsSchema,
  /** The environment-specific ceiling applied on top of each consumer's own maximum. */
  maxCredentialLifetimeSeconds: z.int().min(1).max(86_400),
  clockSkewSeconds: z.int().min(0).max(300)
});
export type PolicyConfig = z.output<typeof PolicyConfigSchema>;
export type PolicyConfigInput = z.input<typeof PolicyConfigSchema>;
