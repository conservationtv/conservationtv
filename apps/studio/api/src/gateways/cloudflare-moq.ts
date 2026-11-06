import { z } from 'zod';
import { trustedTransaction } from '../db/transaction.ts';
import { useEnvironment } from '../env/env.ts';
import { ApiFailure } from '../errors.ts';
import {
  listTokens,
  mintToken,
  revokeToken,
  type CloudflareMoqAccount,
  type MoqOperation,
  type Token
} from './cloudflare-moq-api.ts';
import { provider } from './provider.ts';
import { lockProviderState, selectGatewaySecrets, writeProviderState } from './secrets.ts';

// A gateway that is a Cloudflare MoQ relay (cloudflare-moq-api.ts) in the organisation's own Cloudflare account,
// which the organisation makes and manages there itself: registered with the account's and the relay's IDs as its
// settings and an API token that may manage the account's MoQ relays as its credentials, and published to and read by
// MoQ, as the built-in conservation.tv relay is, with every rendition a track of one broadcast the agent joins. This
// provider only mints tokens for the relay.
//
// Cloudflare's tokens differ from gatekeeper's in three ways, which shape everything here:
//
//   They admit a session to a whole relay, with no path in them. The gateway's exposures share its relay, so a device
//   publishing one of them could publish over another's broadcasts: within an organisation's gateway its publishers
//   are trusted with each other's exposures. Organisations are kept apart by their own accounts.
//
//   Cloudflare mints them, at most 10 per relay, so they cannot be minted per connection. The gateway has two, shared
//   by every caller it admits for that action: one that publishes and subscribes, for its publishers (who read back
//   the rendition broadcasts they join), and one that only subscribes, for its readers. Each lives `TOKEN_LIFETIME_MS`
//   and is replaced once half of that is gone, so the one a caller holds always outlives the ask it should renew it
//   by; the one it replaces stays valid until it expires, and is revoked after. Tokens minted here are labelled, and
//   only they are ever revoked: the organisation's own on the relay are left alone, and count against its 10. Removing
//   a member stops them asking, but what they hold admits them until it expires. The tokens are the gateway's provider
//   state, cleared whenever its settings or credentials change.
//
//   The relay reads the token from the URL's path, not `?jwt=`, so the connection's `path` is the token itself, and
//   no `token` is returned to append. The exposure is then named by its broadcasts: `<exposure>/live.hang`, beside its
//   rendition broadcasts, `<exposure>/<rendition>`.
//
// The relays speak IETF moq-transport (draft-14 and draft-16), not moq-lite, and only over WebTransport or QUIC: the
// moq CLI negotiates draft-16 with them, and the agent's joiner reaches them through its HTTP/3 WebTransport. They
// publish no traffic stats.

/** Cloudflare's draft-16 relays, which take the token as the URL's path. */
const RELAY_URL = 'https://draft-16.cloudflare.mediaoverquic.com/';

/** The exposure's broadcast's name, beneath the exposure's ID, in hang's format: every rendition a track of it. */
const MOQ_BROADCAST = 'live.hang';

/** How long a token admits, from when it is minted. Short, since one cannot be taken back from a single holder. */
const TOKEN_LIFETIME_MS = 24 * 60 * 60_000;

/** What labels the tokens minted here, the only ones on the relay that are ever revoked here. */
const TOKEN_LABEL_PREFIX = 'ctv-';

/** Cloudflare's IDs: 32 lowercase hex digits. */
const CloudflareIdSchema = z.string().regex(/^[0-9a-f]{32}$/u, 'a Cloudflare ID');
export type CloudflareId = z.output<typeof CloudflareIdSchema>;

/** The organisation's relay, and the Cloudflare account it is in, both made and managed there by the organisation. */
const CloudflareMoqSettingsSchema = z.strictObject({
  accountId: CloudflareIdSchema.describe('The Cloudflare account the relay is in.'),
  relayId: CloudflareIdSchema.describe('The MoQ relay, by its `uid`.')
});
export type CloudflareMoqSettings = z.output<typeof CloudflareMoqSettingsSchema>;

/** An API token of that account that may manage its MoQ relays. */
const CloudflareMoqCredentialsSchema = z.strictObject({
  apiToken: z.string().min(1).describe('A Cloudflare API token that may manage the account’s MoQ relays.')
});
export type CloudflareMoqCredentials = z.output<typeof CloudflareMoqCredentialsSchema>;

/** Which of the gateway's tokens: its publishers', or its readers'. */
type TokenKind = 'publish' | 'subscribe';

const OPERATIONS = {
  publish: ['publish', 'subscribe'],
  subscribe: ['subscribe']
} as const satisfies Readonly<Record<TokenKind, readonly MoqOperation[]>>;

/** A token secret, and when it stops admitting. */
const HeldTokenSchema = z.object({ token: z.string(), expiresAt: z.iso.datetime() });
type HeldToken = z.output<typeof HeldTokenSchema>;

/** What the provider keeps for the gateway: the token of each kind it last minted. */
const RelayStateSchema = z.object({ publish: HeldTokenSchema.optional(), subscribe: HeldTokenSchema.optional() });
type RelayState = z.output<typeof RelayStateSchema>;

/** The account's ID, and the token to act in it with. */
function account(settings: CloudflareMoqSettings, credentials: CloudflareMoqCredentials): CloudflareMoqAccount {
  return { accountId: settings.accountId, token: credentials.apiToken };
}

/** The token of the kind the state holds, while more than half its life remains. */
function heldToken(state: RelayState | undefined, kind: TokenKind, now: number): HeldToken | undefined {
  const held = state?.[kind];
  if (held === undefined) return undefined;
  if (Date.parse(held.expiresAt) - now < TOKEN_LIFETIME_MS / 2) return undefined;
  return held;
}

/** The gateway's credentials and provider state, read by trusted code; `gateway_unavailable` without credentials. */
async function gatewaySecrets(organisationId: string, gatewayId: string) {
  const secrets = await selectGatewaySecrets(organisationId, gatewayId);
  const credentials = CloudflareMoqCredentialsSchema.safeParse(secrets?.credentials);
  if (!credentials.success)
    throw new ApiFailure('gateway_unavailable', { cause: 'The gateway has no Cloudflare API token' });
  const state = RelayStateSchema.safeParse(secrets?.state);
  return { credentials: credentials.data, state: state.success ? state.data : undefined };
}

/** Whether the token is one minted here, by its label, that has expired. */
function expiredOfOurs(token: Token, now: number) {
  const ours = token.label?.startsWith(TOKEN_LABEL_PREFIX) ?? false;
  if (!ours || token.expires == null) return false;
  return Date.parse(token.expires) <= now;
}

/**
 * Revokes the tokens minted here that have expired, so they stop counting against the relay's 10. The relay's other
 * tokens are the organisation's. Failures are logged, not thrown: a token minted here is not stranded by them.
 */
async function sweep(cloudflare: CloudflareMoqAccount, relayId: string, now: number) {
  try {
    const tokens = await listTokens(cloudflare, relayId);
    const revocable = tokens.filter(token => expiredOfOurs(token, now));
    for (const token of revocable) await revokeToken(cloudflare, relayId, token.jti);
  } catch (error) {
    console.warn(JSON.stringify({ event: 'cloudflare_moq_sweep_failed', relayId, cause: String(error) }));
  }
}

/**
 * A new token of the kind for the relay, kept in the gateway's state for the next callers, which is otherwise as it
 * was. A token kept nowhere is taken back rather than left counting against the relay's 10.
 */
async function mint(
  gatewayId: string,
  settings: CloudflareMoqSettings,
  credentials: CloudflareMoqCredentials,
  state: RelayState,
  kind: TokenKind,
  now: number
): Promise<HeldToken> {
  const cloudflare = account(settings, credentials);
  const expiresAt = new Date(now + TOKEN_LIFETIME_MS);
  const label = `${TOKEN_LABEL_PREFIX}${kind}`;
  const minted = await mintToken(cloudflare, settings.relayId, OPERATIONS[kind], expiresAt, label);
  const held: HeldToken = { token: minted.secret, expiresAt: expiresAt.toISOString() };
  try {
    await writeProviderState(gatewayId, { ...state, [kind]: held });
  } catch (error) {
    await revokeToken(cloudflare, settings.relayId, minted.jti).catch(() => undefined);
    throw error;
  }
  await sweep(cloudflare, settings.relayId, now);
  return held;
}

/**
 * The gateway's token of the kind: the one held while it has more than half its life left, otherwise a new one.
 * Cloudflare is called inside the trusted transaction holding the
 * gateway's provider-state lock, so concurrent callers wait and share what one of them made; that happens only a few
 * times a day per gateway.
 */
async function gatewayToken(
  organisationId: string,
  gatewayId: string,
  settings: CloudflareMoqSettings,
  kind: TokenKind
): Promise<HeldToken> {
  const environment = useEnvironment();
  const now = environment.clock();
  const kept = await trustedTransaction(() => gatewaySecrets(organisationId, gatewayId));
  const held = heldToken(kept.state, kind, now);
  if (held !== undefined) return held;
  return trustedTransaction(async () => {
    await lockProviderState(gatewayId);
    const { credentials, state } = await gatewaySecrets(organisationId, gatewayId);
    const current = heldToken(state, kind, now);
    if (current !== undefined) return current;
    return mint(gatewayId, settings, credentials, state ?? {}, kind, now);
  });
}

export const cloudflareMoq = provider.organisation({
  name: 'Cloudflare MoQ',
  // One broadcast carries every rendition of the exposure, as tracks.
  ingest: { moq: 'tracks' },
  egress: { moq: 'tracks' },
  settings: CloudflareMoqSettingsSchema,
  credentials: CloudflareMoqCredentialsSchema,
  // The token must reach the relay's tokens, which minting them needs, in the account named.
  verify: async (settings, credentials) => {
    const cloudflare = account(settings, credentials);
    try {
      await listTokens(cloudflare, settings.relayId);
    } catch (cause) {
      throw new ApiFailure('invalid_credentials', { cause });
    }
  },
  connect: async request => {
    const kind: TokenKind = request.action === 'publish' ? 'publish' : 'subscribe';
    const { token, expiresAt } = await gatewayToken(request.organisationId, request.gatewayId, request.settings, kind);
    return {
      protocol: 'moq',
      relay: RELAY_URL,
      // The relay reads the token as the URL's path.
      path: token,
      broadcast: `${request.exposure.id}/${MOQ_BROADCAST}`,
      expiresAt
    };
  }
});
