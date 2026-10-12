import type { ConsumerRegistration, PolicyConfig } from '../config/schemas.ts';
import { GrantError } from '../errors.ts';
import type { GrantV1, IrohRequest, MoqRequest } from './grant.ts';
import { PROTOCOL_MAX_LIFETIME_SECONDS } from './grant.ts';
import { hasSubjectPrefix, isWithinPath } from './identifiers.ts';

// Steps 7 and 8. Every requested capability must be a subset of the registration's delegation. Nothing is ever widened
// or trimmed to fit: a request is accepted as signed or rejected.

function authorizeMoq(registration: ConsumerRegistration, moq: MoqRequest) {
  const delegated = registration.delegation.moq;
  if (!delegated) throw new GrantError('capability_not_delegated');
  if (!delegated.roots.some(root => isWithinPath(moq.root, root))) throw new GrantError('invalid_resource');
  if (moq.publish.length && !delegated.actions.includes('publish')) throw new GrantError('capability_not_delegated');
  if (moq.subscribe.length && !delegated.actions.includes('subscribe')) {
    throw new GrantError('capability_not_delegated');
  }
}

function authorizeIroh(registration: ConsumerRegistration, iroh: IrohRequest, policy: PolicyConfig) {
  if (!registration.delegation.iroh?.actions.includes(iroh.action)) throw new GrantError('capability_not_delegated');
  if (policy.deniedIrohEndpoints.includes(iroh.endpoint_id)) throw new GrantError('invalid_endpoint_id');
}

export function authorizeGrant(registration: ConsumerRegistration, grant: GrantV1, policy: PolicyConfig): void {
  const prefixes = registration.delegation.subject_prefixes;
  if (!prefixes.some(prefix => hasSubjectPrefix(grant.subject, prefix))) throw new GrantError('invalid_subject');
  const { moq, iroh } = grant.requested_capabilities;
  if (moq) authorizeMoq(registration, moq);
  if (iroh) authorizeIroh(registration, iroh, policy);
}

/** The lowest of the requested, consumer, environment and protocol lifetimes. */
export function effectiveLifetimeSeconds(
  registration: ConsumerRegistration,
  grant: GrantV1,
  policy: PolicyConfig
): number {
  return Math.min(
    grant.expires_in,
    registration.delegation.max_credential_lifetime_seconds,
    policy.maxCredentialLifetimeSeconds,
    PROTOCOL_MAX_LIFETIME_SECONDS
  );
}
