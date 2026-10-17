import { useEnvironment } from '../env/env.ts';
import { locateRegistration, parseAssertion, verifyAssertion } from './assertion.ts';
import { authorizeGrant } from './delegation.ts';
import { parseGrant } from './grant.ts';
import { type GrantExchangeResult, issueCredentials } from './issue.ts';

/**
 * Exchange a consumer-signed grant assertion for relay credentials, in the documented order. The signed `grant` is
 * only read after the signature and registered claims have been verified.
 */
export async function exchangeGrant(grantAssertion: string): Promise<GrantExchangeResult> {
  const { policy } = useEnvironment();
  const envelope = parseAssertion(grantAssertion);
  const registration = locateRegistration(policy.consumers, envelope.identity);
  const assertion = await verifyAssertion(registration, envelope);
  const grant = parseGrant(assertion.claims.grant);
  authorizeGrant(registration, grant, policy);
  return issueCredentials(registration, assertion, grant);
}
