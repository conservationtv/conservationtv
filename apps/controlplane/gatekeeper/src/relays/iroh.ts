import { and, eq, gt, inArray, isNull } from 'drizzle-orm';
import { grants, irohLeases } from '../db/schema.ts';
import { EndpointIdSchema } from '../grants/identifiers.ts';
import { useEnvironment } from '../env/env.ts';
import { matchesSecret } from './secrets.ts';

export type RelayAdmission = 'allow' | 'deny' | 'unauthenticated';

/** iroh-relay sends its `access.http.bearer_token` as a standard bearer credential. */
const isRelayToken = (authorization: string | undefined) =>
  matchesSecret(/^Bearer (.+)$/.exec(authorization ?? '')?.[1], useEnvironment().variables.IROH_RELAY_TOKEN);

/**
 * The Iroh relay's access callout. Admits an endpoint only while it holds an active, unexpired lease whose grant has
 * not been revoked, issued to a consumer that is still registered and enabled, for an endpoint that isn't denied.
 */
export async function admitIrohEndpoint(
  authorization: string | undefined,
  endpointHeader: string | undefined
): Promise<RelayAdmission> {
  if (!(await isRelayToken(authorization))) return 'unauthenticated';
  const endpoint = EndpointIdSchema.safeParse(endpointHeader);
  const { policy, clock } = useEnvironment();
  if (!endpoint.success || policy.deniedIrohEndpoints.includes(endpoint.data)) return 'deny';
  const principals = policy.consumers.filter(consumer => consumer.enabled).map(consumer => consumer.principal_id);
  if (principals.length === 0) return 'deny';
  const db = await useEnvironment().database();
  const [lease] = await db
    .select({ id: irohLeases.id })
    .from(irohLeases)
    .innerJoin(grants, eq(grants.id, irohLeases.grantId))
    .where(
      and(
        eq(irohLeases.endpointId, endpoint.data),
        eq(irohLeases.status, 'active'),
        gt(irohLeases.expiresAt, new Date(clock())),
        inArray(irohLeases.principalId, principals),
        isNull(grants.revokedAt)
      )
    )
    .limit(1);
  return lease ? 'allow' : 'deny';
}
