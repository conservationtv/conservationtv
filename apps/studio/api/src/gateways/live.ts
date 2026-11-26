import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { exposures, gateways } from '../db/schema.ts';
import { transaction, useDB } from '../db/transaction.ts';
import { useEnvironment } from '../env/env.ts';
import { usePrincipal } from '../middleware/principal.ts';
import { BUILTIN_GATEWAYS, gatewayProvider, isBuiltinGateway } from './index.ts';
import type { GatewayProvider, LiveDeliveries } from './provider.ts';

// Which of an organisation's exposures are live now (docs/shows.md, Going live), each answered by its gateway's own
// source of truth, through its provider (src/gateways/provider.ts): the relay's announcements for conservation.tv,
// what the agent running a MediaMTX gateway last said of its paths. Each gateway is asked once for all of the
// organisation's exposures there, and its answer is kept for a few seconds in the cache, so a page that asks every few
// seconds asks the gateway no more often than that. A gateway that cannot be asked, or fails to answer, leaves its
// exposures unknown (`live: null`) without failing the rest.

/** How long a gateway's answer stands for everyone who asks. */
const LIVE_SECONDS = 5;

/** What a gateway's answer is kept as. KV keeps it for a minute at least, so how old it is decides, not its expiry. */
const KeptLiveSchema = z.object({
  checkedAt: z.number(),
  live: z.record(z.string(), z.boolean().nullable())
});
type KeptLive = z.output<typeof KeptLiveSchema>;

/** Where a gateway's answer about an organisation is kept. */
const liveKey = (organisationId: string, gatewayId: string) => `live:${organisationId}:${gatewayId}`;

/** A gateway's answer about some of the organisation's exposures, and when it was had: null when it could not say. */
interface GatewayAnswer {
  checkedAt: number | null;
  live: LiveDeliveries;
}

/** One of the organisation's own gateways, and its kind. */
interface OwnGateway {
  id: string;
  kind: string;
}

/** The organisation's exposures, and its own gateways' kinds, as the caller sees them. */
async function selectExposures(organisationId: string) {
  const db = useDB();
  const rows = await db
    .select({ id: exposures.id, streamId: exposures.streamId, gatewayId: exposures.gatewayId })
    .from(exposures)
    .where(eq(exposures.organisationId, organisationId))
    .orderBy(exposures.id);
  const own = await db
    .select({ id: gateways.id, kind: gateways.kind })
    .from(gateways)
    .where(eq(gateways.organisationId, organisationId));
  return { rows, own };
}

/** The answer kept for the gateway, while it is fresh and says of every exposure asked of; none otherwise. */
async function keptAnswer(key: string, deliveryIds: readonly string[], now: number): Promise<KeptLive | undefined> {
  const environment = useEnvironment();
  try {
    const raw = await environment.cache.get(key);
    if (raw === null) return undefined;
    const kept = KeptLiveSchema.parse(JSON.parse(raw));
    const fresh = now - kept.checkedAt < LIVE_SECONDS * 1000;
    return fresh && deliveryIds.every(id => Object.hasOwn(kept.live, id)) ? kept : undefined;
  } catch {
    return undefined;
  }
}

/** Keep the gateway's answer; a cache that cannot keep it only means the gateway is asked again sooner. */
async function keepAnswer(key: string, answer: KeptLive): Promise<void> {
  const environment = useEnvironment();
  try {
    await environment.cache.put(key, JSON.stringify(answer), LIVE_SECONDS);
  } catch (error) {
    console.warn(JSON.stringify({ event: 'live_cache_failed', key, cause: String(error) }));
  }
}

/** One gateway, and the organisation's exposures at it, asked of for a caller. */
export interface GatewayAsk {
  organisationId: string;
  gatewayId: string;
  kind: string;
  deliveryIds: string[];
  subject: string;
}

/** How a gateway says what is live on it: none for a gateway that cannot, or a kind with no provider. */
function liveOf(gatewayId: string, kind: string): GatewayProvider['live'] {
  try {
    return gatewayProvider(gatewayId, kind).live;
  } catch {
    return undefined;
  }
}

/**
 * Which of the deliveries at one gateway are live: from the cache, else the gateway itself; unknown if it can't say.
 * Also how a reader of a pushed stream prefers the chain that is live (src/gateways/connect.ts).
 */
export async function askGateway(ask: GatewayAsk): Promise<GatewayAnswer> {
  const { organisationId, gatewayId, deliveryIds, subject } = ask;
  const unknown: GatewayAnswer = { checkedAt: null, live: Object.fromEntries(deliveryIds.map(id => [id, null])) };
  const live = liveOf(gatewayId, ask.kind);
  if (live === undefined) return unknown;
  const environment = useEnvironment();
  const now = environment.clock();
  const key = liveKey(organisationId, gatewayId);
  const kept = await keptAnswer(key, deliveryIds, now);
  if (kept !== undefined) return kept;
  try {
    const answer = await live({ organisationId, gatewayId, deliveryIds, subject });
    const checked: KeptLive = { checkedAt: now, live: answer };
    await keepAnswer(key, checked);
    return checked;
  } catch (error) {
    console.warn(JSON.stringify({ event: 'live_unanswered', organisationId, gatewayId, cause: String(error) }));
    return unknown;
  }
}

/**
 * Each of the organisation's exposures the caller sees, oldest first, with whether it is live now (null when its
 * gateway cannot say) and when its gateway said so. Empty for an organisation the caller is not a member of.
 */
export async function liveExposures(organisationId: string) {
  const principal = usePrincipal();
  const subject = `${principal.kind}:${principal.id}`;
  const { rows, own } = await transaction(() => selectExposures(organisationId));
  const gatewayIds = [...new Set(rows.map(row => row.gatewayId))];
  const answered = await Promise.all(
    gatewayIds.map(async gatewayId => {
      const at = rows.filter(row => row.gatewayId === gatewayId);
      const kind = kindOf(gatewayId, own);
      const deliveryIds = at.map(row => row.id);
      const answer = await askGateway({ organisationId, gatewayId, kind, deliveryIds, subject });
      const checkedAt = answer.checkedAt === null ? null : new Date(answer.checkedAt).toISOString();
      return at.map(row => ({ ...row, live: answer.live[row.id] ?? null, checkedAt }));
    })
  );
  // Oldest first, as they were read: their IDs are UUIDv7s.
  return answered.flat().sort((a, b) => a.id.localeCompare(b.id));
}

/** A gateway's kind: a built-in one's own, or the organisation's gateway's; none for one it does not have. */
function kindOf(gatewayId: string, own: readonly OwnGateway[]): string {
  if (isBuiltinGateway(gatewayId)) return BUILTIN_GATEWAYS[gatewayId].kind;
  return own.find(gateway => gateway.id === gatewayId)?.kind ?? '';
}
