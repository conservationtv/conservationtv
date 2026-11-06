import { z } from 'zod';
import { ApiFailure } from '../errors.ts';

// The tokens of Cloudflare's MoQ relays (https://developers.cloudflare.com/moq/), through the account API
// (https://developers.cloudflare.com/api/resources/moq): a relay is an isolated scope of namespaces on Cloudflare's
// network, and a token admits a session to the whole relay, to publish, subscribe or both. Cloudflare alone mints
// tokens, shows each one's secret once, holds at most 10 per relay, and revokes them by `jti`. Relays themselves are
// made and removed by their account's owners, not here. The API is in beta, and Cloudflare says it will change.

const API = 'https://api.cloudflare.com/client/v4';

/** An organisation's account, which its gateway's relay is in, and an API token that may manage its MoQ relays. */
export interface CloudflareMoqAccount {
  accountId: string;
  token: string;
}

/** What a relay token admits its session to. */
export type MoqOperation = 'publish' | 'subscribe';

/** What every response is wrapped in. */
const EnvelopeSchema = z.object({
  success: z.boolean(),
  errors: z.array(z.object({ code: z.number(), message: z.string() })).default([]),
  result: z.unknown()
});
type Envelope = z.output<typeof EnvelopeSchema>;

/** A token as Cloudflare lists it; `secret` only in the response that minted it. */
const TokenSchema = z.object({
  jti: z.string().min(1),
  expires: z.string().nullish(),
  label: z.string().nullish(),
  secret: z.string().optional()
});
export type Token = z.output<typeof TokenSchema>;

/** Tokens come grouped by who issued them, which is only ever Cloudflare: flattened. */
const IssuedTokensSchema = z
  .array(z.object({ cloudflare_tokens: z.array(TokenSchema).default([]) }))
  .default([])
  .transform(issuers => issuers.flatMap(issuer => issuer.cloudflare_tokens));
type IssuedTokens = z.output<typeof IssuedTokensSchema>;

/** A token response's body. */
const IssuersSchema = z.object({ issuers: IssuedTokensSchema });
type Issuers = z.output<typeof IssuersSchema>;

/** What minting a token is asked with: `expires` RFC 3339. */
interface TokenRequest {
  operations: readonly MoqOperation[];
  expires: string;
  label: string;
}

/** One call to the account's relays, its result as `schema`; `gateway_unavailable` with what Cloudflare said when it refuses. */
async function call<Schema extends z.ZodType>(
  account: CloudflareMoqAccount,
  method: string,
  path: string,
  schema: Schema,
  body?: TokenRequest
): Promise<z.output<Schema>> {
  const response = await fetch(`${API}/accounts/${account.accountId}/moq/relays${path}`, {
    method,
    headers: { authorization: `Bearer ${account.token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const parsed = EnvelopeSchema.safeParse(await response.json().catch(() => undefined));
  const envelope: Envelope | undefined = parsed.success ? parsed.data : undefined;
  if (envelope?.success) return schema.parse(envelope.result);
  const reasons =
    envelope === undefined
      ? `${response.status} ${response.statusText}`
      : envelope.errors.map(error => `${error.code} ${error.message}`).join('; ');
  throw new ApiFailure('gateway_unavailable', { cause: `Cloudflare MoQ refused ${method} ${path}: ${reasons}` });
}

/** A token admitting a session to the relay for the operations until `expires`, labelled; with its secret. */
export async function mintToken(
  account: CloudflareMoqAccount,
  relayId: string,
  operations: readonly MoqOperation[],
  expires: Date,
  label: string
) {
  const body: TokenRequest = { operations, expires: expires.toISOString(), label };
  const { issuers }: Issuers = await call(account, 'POST', `/${relayId}/tokens`, IssuersSchema, body);
  const [token] = issuers;
  if (token?.secret === undefined) {
    throw new ApiFailure('gateway_unavailable', { cause: 'Cloudflare MoQ minted no token secret' });
  }
  return { ...token, secret: token.secret };
}

/** The relay's tokens, without their secrets. */
export async function listTokens(account: CloudflareMoqAccount, relayId: string): Promise<IssuedTokens> {
  const { issuers } = await call(account, 'GET', `/${relayId}/tokens`, IssuersSchema);
  return issuers;
}

export async function revokeToken(account: CloudflareMoqAccount, relayId: string, jti: string): Promise<void> {
  await call(account, 'DELETE', `/${relayId}/tokens/${jti}`, z.unknown());
}
