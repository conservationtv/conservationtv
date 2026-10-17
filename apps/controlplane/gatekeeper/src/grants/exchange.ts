import { useEnvironment } from '../env/env.ts';
import { GrantError } from '../errors.ts';
import type { Grant } from './grant.ts';
import { type GrantExchangeResult, issueCredentials } from './issue.ts';

/**
 * Exchange the consumer's grant for relay credentials. The consumer is trusted with the environment's relays, so the
 * grant is issued as asked, within the environment's lifetime ceiling, unless it names a denied endpoint.
 */
export async function exchangeGrant(grant: Grant): Promise<GrantExchangeResult> {
  const endpointId = grant.requested_capabilities.iroh?.endpoint_id;
  if (endpointId !== undefined && useEnvironment().variables.DENIED_IROH_ENDPOINTS.includes(endpointId)) {
    throw new GrantError('invalid_endpoint_id');
  }
  return issueCredentials(grant);
}
