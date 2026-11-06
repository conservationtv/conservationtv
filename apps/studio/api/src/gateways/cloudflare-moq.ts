import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { cloudflareMoqRelays } from '../db/schema.ts';
import { trustedTransaction, useDB } from '../db/transaction.ts';
import { useEnvironment } from '../env/env.ts';
import { ApiFailure } from '../errors.ts';
import {
  createRelay,
  deleteRelay,
  listTokens,
  mintToken,
  relaysNamed,
  revokeToken,
  type CloudflareMoqAccount,
  type MoqOperation,
  type Token
} from './cloudflare-moq-api.ts';
import { provider } from './provider.ts';

// A gateway that is a Cloudflare MoQ relay (cloudflare-moq-api.ts), in the deployment's Cloudflare account
// (CLOUDFLARE_MOQ_ACCOUNT_ID): published to and read by MoQ, as the built-in conservation.tv relay is, with every
// rendition a track of one broadcast the agent joins.
//
// Cloudflare's tokens differ from gatekeeper's in three ways, which shape everything here:
//
//   They admit a session to a whole relay, with no path in them, so a relay must hold one gateway's exposures and no
//   one else's: each gateway is a relay of its own, made the first time anyone connects to it and named for it
//   (`ctv-<gateway>`), so one made by a connect that then failed is found again rather than made twice.
//
//   Cloudflare mints them, at most 10 per relay, so they cannot be minted per connection. Each gateway has two,
//   shared by every caller it admits for that action: one that publishes and subscribes, for its publishers (who read
//   back the rendition broadcasts they join), and one that only subscribes, for its readers. Each lives
//   `TOKEN_LIFETIME_MS` and is replaced once half of that is gone, so the one a caller holds always outlives the ask
//   it should renew it by; the one it replaces stays valid until it expires, and is revoked after. Removing a member
//   stops them asking, but what they hold admits them until it expires.
//
//   The relay reads the token from the URL's path, not `?jwt=`, so the connection's `path` is the token itself, and
//   no `token` is returned to append. The exposure is then named by its broadcasts: `<exposure>/live.hang`, beside its
//   rendition broadcasts, `<exposure>/<rendition>`.
//
// The relays speak IETF moq-transport (draft-14 and draft-16), not moq-lite; the moq CLI and @moq/net negotiate
// draft-16 with them. They publish no traffic stats.

/** Cloudflare's draft-16 relays, which take the token as the URL's path. */
const RELAY_URL = 'https://draft-16.cloudflare.mediaoverquic.com/';

/** The exposure's broadcast's name, beneath the exposure's ID, in hang's format: every rendition a track of it. */
const MOQ_BROADCAST = 'live.hang';

/** How long a token admits, from when it is minted. Short, since one cannot be taken back from a single holder. */
const TOKEN_LIFETIME_MS = 24 * 60 * 60_000;

/** What labels the tokens minted here, so any others on the relay (Cloudflare's own, from making it) are revoked. */
const TOKEN_LABEL_PREFIX = 'ctv-';

/** The gateway's relay's name at Cloudflare. */
const relayName = (gatewayId: string) => `ctv-${gatewayId}`;

/** Which of the gateway's tokens: its publishers', or its readers'. */
type TokenKind = 'publish' | 'subscribe';

const OPERATIONS = {
  publish: ['publish', 'subscribe'],
  subscribe: ['subscribe']
} as const satisfies Readonly<Record<TokenKind, readonly MoqOperation[]>>;

type RelayRow = typeof cloudflareMoqRelays.$inferSelect;

/** A token secret, and when it stops admitting. */
interface HeldToken {
  token: string;
  expiresAt: Date;
}

/** Nothing to register: where the relay is, and who it admits, are this provider's. */
const CloudflareMoqSettingsSchema = z.strictObject({});
export type CloudflareMoqSettings = z.output<typeof CloudflareMoqSettingsSchema>;

/** The deployment's account; `gateway_unavailable` when there is none. */
function useAccount(): CloudflareMoqAccount {
  const environment = useEnvironment();
  const account = environment.cloudflareMoq;
  if (account === undefined)
    throw new ApiFailure('gateway_unavailable', { cause: 'No Cloudflare account is configured for MoQ relays' });
  return account;
}

/** The token of the kind the row holds, while more than half its life remains. */
function heldToken(row: RelayRow | undefined, kind: TokenKind, now: number): HeldToken | undefined {
  if (row === undefined) return undefined;
  const token = kind === 'publish' ? row.publishToken : row.subscribeToken;
  const expiresAt = kind === 'publish' ? row.publishExpiresAt : row.subscribeExpiresAt;
  if (token === null || expiresAt === null) return undefined;
  if (expiresAt.getTime() - now < TOKEN_LIFETIME_MS / 2) return undefined;
  return { token, expiresAt };
}

async function selectRelay(gatewayId: string) {
  const db = useDB({ trusted: true });
  const [row] = await db.select().from(cloudflareMoqRelays).where(eq(cloudflareMoqRelays.gatewayId, gatewayId));
  return row;
}

/** The gateway's row: made the first time, for its relay at Cloudflare, found by name or made. */
async function relayFor(account: CloudflareMoqAccount, organisationId: string, gatewayId: string) {
  const existing = await selectRelay(gatewayId);
  if (existing !== undefined) return existing;
  const name = relayName(gatewayId);
  const [found] = await relaysNamed(account, name);
  const relay = found ?? (await createRelay(account, name));
  const db = useDB({ trusted: true });
  const [created] = await db
    .insert(cloudflareMoqRelays)
    .values({ organisationId, gatewayId, relayId: relay.uid })
    .returning();
  return created!;
}

/** Whether the token is one minted here, by its label, that still admits. */
function admitsForUs(token: Token, now: number) {
  const ours = token.label?.startsWith(TOKEN_LABEL_PREFIX) ?? false;
  if (!ours) return false;
  if (token.expires == null) return true;
  return Date.parse(token.expires) > now;
}

/**
 * Revokes the relay's tokens that were not minted here, such as the two Cloudflare mints with a relay, and those
 * minted here that have expired, so the relay stays under its 10. Failures are logged, not thrown: a token minted
 * here is not stranded by them.
 */
async function sweep(account: CloudflareMoqAccount, relayId: string, now: number) {
  try {
    const tokens = await listTokens(account, relayId);
    const revocable = tokens.filter(token => !admitsForUs(token, now));
    for (const token of revocable) await revokeToken(account, relayId, token.jti);
  } catch (error) {
    console.warn(JSON.stringify({ event: 'cloudflare_moq_sweep_failed', relayId, cause: String(error) }));
  }
}

/**
 * A new token of the kind for the gateway's relay, kept for the next callers. Runs with the gateway's lock held, so
 * concurrent callers wait and share it rather than each minting one.
 */
async function mint(account: CloudflareMoqAccount, row: RelayRow, kind: TokenKind, now: number): Promise<HeldToken> {
  const expiresAt = new Date(now + TOKEN_LIFETIME_MS);
  const label = `${TOKEN_LABEL_PREFIX}${kind}`;
  const minted = await mintToken(account, row.relayId, OPERATIONS[kind], expiresAt, label);
  try {
    const changes =
      kind === 'publish'
        ? { publishToken: minted.secret, publishExpiresAt: expiresAt }
        : { subscribeToken: minted.secret, subscribeExpiresAt: expiresAt };
    const db = useDB({ trusted: true });
    await db.update(cloudflareMoqRelays).set(changes).where(eq(cloudflareMoqRelays.gatewayId, row.gatewayId));
  } catch (error) {
    // Kept nowhere, so nobody could be handed it: take it back rather than let it count against the relay's 10.
    await revokeToken(account, row.relayId, minted.jti).catch(() => undefined);
    throw error;
  }
  await sweep(account, row.relayId, now);
  return { token: minted.secret, expiresAt };
}

/**
 * The gateway's token of the kind: the one held while it has more than half its life left, otherwise a new one,
 * with the relay made first if the gateway has none yet. Read by trusted code, since the secrets are hidden from
 * request sessions; Cloudflare is called inside the transaction holding the gateway's lock, which only happens a few
 * times a day per gateway.
 */
async function gatewayToken(organisationId: string, gatewayId: string, kind: TokenKind): Promise<HeldToken> {
  const account = useAccount();
  const environment = useEnvironment();
  const now = environment.clock();
  const kept = await trustedTransaction(() => selectRelay(gatewayId));
  const held = heldToken(kept, kind, now);
  if (held !== undefined) return held;
  return trustedTransaction(async () => {
    const db = useDB({ trusted: true });
    await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`cloudflare-moq:${gatewayId}`}, 0))`);
    const row = await relayFor(account, organisationId, gatewayId);
    const current = heldToken(row, kind, now);
    return current ?? mint(account, row, kind, now);
  });
}

export const cloudflareMoq = provider.organisation({
  name: 'Cloudflare MoQ',
  // One broadcast carries every rendition of the exposure, as tracks.
  ingest: { moq: 'tracks' },
  egress: { moq: 'tracks' },
  settings: CloudflareMoqSettingsSchema,
  connect: async request => {
    const kind: TokenKind = request.action === 'publish' ? 'publish' : 'subscribe';
    const { token, expiresAt } = await gatewayToken(request.organisationId, request.gatewayId, kind);
    return {
      protocol: 'moq',
      relay: RELAY_URL,
      // The relay reads the token as the URL's path.
      path: token,
      broadcast: `${request.exposure.id}/${MOQ_BROADCAST}`,
      expiresAt: expiresAt.toISOString()
    };
  },
  // The relay goes with its gateway: every relay by its name, in case a failed connect left one behind.
  retire: async gateway => {
    const account = useAccount();
    const relays = await relaysNamed(account, relayName(gateway.id));
    for (const relay of relays) await deleteRelay(account, relay.uid);
  }
});
