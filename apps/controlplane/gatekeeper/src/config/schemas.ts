import { z } from 'zod';
import { EndpointIdSchema, MoqPathSchema, SubjectPrefixSchema } from '../grants/identifiers.ts';

export const GRANT_ASSERTION_TYPE = 'relay-grant+jwt';

/** Asymmetric algorithms a consumer may register. `none` and shared-secret algorithms are never accepted. */
export const AssertionAlgorithmSchema = z.enum(['ES256', 'ES384', 'EdDSA', 'RS256', 'PS256']);
export type AssertionAlgorithm = z.output<typeof AssertionAlgorithmSchema>;

const PROHIBITED_HOST = /^(localhost|.*\.localhost|.*\.local|.*\.internal|\[.*\]|\d{1,3}(\.\d{1,3}){3})$/i;

/** The URLs a registration names: HTTP or HTTPS, as `isSecureRegistration` decides for the deployment. */
const ConsumerUrlSchema = z.url({ protocol: /^https?$/ });
type ConsumerUrl = z.output<typeof ConsumerUrlSchema>;

/** Consumer JWKS locations are fixed by registration, without credentials or fragments. */
export const JwksUriSchema = ConsumerUrlSchema.refine(value => {
  const url = new URL(value);
  return !url.username && !url.password && !url.hash;
}, 'JWKS URIs must not carry credentials or fragments');
export type JwksUri = z.output<typeof JwksUriSchema>;

const isHttps = (value: ConsumerUrl) => new URL(value).protocol === 'https:';

/**
 * Whether every URL the registration names is HTTPS, and its JWKS is on a public DNS name: IP literals and local names
 * are refused so a registration can't point the fetcher at internal infrastructure. Every deployment requires it but
 * local development, which sets `ALLOW_INSECURE_CONSUMERS` for consumers on plain HTTP at localhost.
 */
export function isSecureRegistration({ authentication }: ConsumerRegistration): boolean {
  const { hostname } = new URL(authentication.jwks_uri);
  return (
    [authentication.issuer, authentication.audience, authentication.jwks_uri].every(isHttps) &&
    z.regexes.domain.test(hostname) &&
    !PROHIBITED_HOST.test(hostname)
  );
}

const AuthenticationSchema = z.strictObject({
  method: z.literal('federated_jwt'),
  issuer: ConsumerUrlSchema,
  jwks_uri: JwksUriSchema,
  audience: ConsumerUrlSchema,
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
