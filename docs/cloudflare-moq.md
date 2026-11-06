# Proposal: a Cloudflare MoQ gateway

Status: implemented in this branch. A smoke test against a live Cloudflare relay found one blocker (the joiner, below).

## How publishing works today

An exposure delivered to the built-in `conservationtv` gateway goes through the gatekeeper-managed moq-relay:

1. **Planning.** The studio API plans each active agent's configuration (`apps/studio/api/src/configuration/plan`).
   An exposure whose gateway's provider has `ingest.moq === 'tracks'` becomes a _publisher_. Its `connect` ask is
   `organisations.streams.exposures.connect` with `action: 'publish', protocol: 'moq'`.
2. **Credentials.** The agent makes that ask, signed with its device identity (RFC 9421). The studio API
   (`src/gateways/connect.ts`) checks that the device is the exposure's pinned publisher, then calls the gateway's
   provider. `conservationtv` (`src/gateways/conservationtv.ts`) exchanges a grant with gatekeeper
   (`src/gatekeeper/grants.ts`) using the environment's consumer token. The grant is
   `{ moq: { root: '<org>/<exposure>', publish: [''], subscribe: [''] } }`, and it lives an hour.
3. **Gatekeeper.** Gatekeeper records the grant and signs an ES256 JWT with only the claims `root`, `publish`,
   `subscribe`, `iat`, `exp` and `jti`. The root is placed beneath the consumer's namespace. Gatekeeper returns the
   relay URL, the root and the token.
4. **The answer.** The studio API answers with `{ relay, path: <root>, broadcast: 'live.hang', token, expiresAt }`.
5. **Dialling.** The agent dials `new URL(path, relay)` with `?jwt=<token>`
   (`apps/agent/core/src/studio-configuration.ts`). It asks again 10 minutes before `expiresAt`.
6. **MediaMTX.** MediaMTX runs one `moq import --broadcast <rendition> rtmp …` per rendition from `runOnInit`
   (`builders/publishers.ts`). Each pulls its rendition from loopback RTMP.
7. **Joining.** The agent joins the rendition broadcasts into `live.hang` (`joiner.ts`). That broadcast's hang
   catalog points at each rendition's tracks by `./<rendition>`.
8. **Admission.** moq-relay calls gatekeeper's `/relays/moq/admission` for each session. Gatekeeper verifies the JWT,
   checks the grant is still recorded and unrevoked, and scopes its permissions to the dialled path. It does this
   again every 60 seconds.
9. **Readers.** Readers (members, or devices reading an upstream) get the same answer with subscribe-only grants. Relay
   nodes also publish traffic stats, which the agent reads through `organisations.gateways.stats.connect`.

## What Cloudflare's relay offers

Sources: [MoQ docs](https://developers.cloudflare.com/moq/), [API](https://developers.cloudflare.com/api/resources/moq),
[launch post](https://blog.cloudflare.com/moq-relays/), as of 2026-11. The product is in beta and free, and Cloudflare
says the API will change.

|              | Gatekeeper's moq-relay                      | Cloudflare MoQ relay                                                 |
| ------------ | ------------------------------------------- | -------------------------------------------------------------------- |
| Protocol     | moq-lite (and IETF drafts)                  | IETF moq-transport draft-14, draft-16 (draft-18 coming)              |
| Endpoint     | `MOQ_RELAY_URL`                             | `https://draft-16.cloudflare.mediaoverquic.com/<token>`              |
| Tenancy      | one relay, paths namespaced per consumer    | a relay per `POST /accounts/{id}/moq/relays`, each an isolated scope |
| Token signer | gatekeeper, ES256, our claims               | Cloudflare only (EdDSA, `kid: moq-v1`), no bring-your-own key        |
| Token scope  | a root path plus publish/subscribe subtrees | the whole relay; `operations: publish \| subscribe`                  |
| Token count  | unlimited, one per connection               | at most 10 per relay, secret shown once, revoke by `jti`, ≤ 1 year   |
| Presented as | `?jwt=` or SETUP token                      | the URL's path                                                       |
| Revalidation | every 60 s, by grant                        | on session open only                                                 |
| Stats        | per-node broadcasts                         | none (relay `status: connected` only)                                |

The moq CLI (0.14.7) and `@moq/net`, which the agent already ships, speak both moq-lite and the IETF drafts. They
negotiate by ALPN and offer `moqt-16` and `moq-00` (draft-14) beside moq-lite, so no agent dependency changes.

## Design

The new organisation gateway kind is **`cloudflare-moq`** (`apps/studio/api/src/gateways/cloudflare-moq.ts`). It is
registered like `mediamtx`, with `networkId: null` and settings `{}`. Its ingest and egress are both
`{ moq: 'tracks' }`, so the configuration planner already makes agents publish to it with no planner changes.

- **A relay per gateway.** Tokens can't be scoped to a path, so a relay must never hold more than one gateway's
  exposures. The first `connect` creates the relay named `ctv-<gatewayId>`, or finds it by that name if a failed
  attempt already created it. The relay is recorded in `cloudflare_moq_relay`. Removing the gateway deletes every relay
  by that name in the background (`retire`, a new optional provider hook).
- **Two shared tokens per gateway.** The 10-token cap rules out a token per connection, so each gateway holds two:
  - publish+subscribe, for publishers, because the joiner reads back the rendition catalogs;
  - subscribe-only, for readers.

  Both are stored encrypted (`encrypted()` columns, hidden from request sessions). Each lives 24 hours. It is replaced
  once less than 12 hours remain, so a holder renewing 10 minutes before expiry always gets a fresh one. A replaced
  token stays valid until it expires. Minting runs under a per-gateway advisory lock, so concurrent callers share one
  mint. After each mint, any token not labelled `ctv-*` is revoked, and so is any expired token. That covers the two
  tokens Cloudflare mints with a new relay. At most about 4 tokens exist at a time.

- **The token travels in the path.** `connect` answers `{ relay: 'https://draft-16.cloudflare.mediaoverquic.com/',
path: <token>, broadcast: '<exposure>/live.hang', expiresAt }` with no `token` field. The agent and the web client
  already build `new URL(path, relay)` and only add `?jwt=` when a token is present, so neither changes. The
  `MoqConnection.path` documentation now says some relays read their credential from the path.
- **Broadcasts are named under the exposure.** A Cloudflare relay has no path prefix per connection. The agent
  therefore publishes each rendition broadcast _beside_ the joined one: `renditionBroadcast()` in
  `apps/agent/core/src/runtimes/mediamtx/config.ts`. On `conservationtv` this changes nothing, because the joined
  broadcast is `live.hang` and the renditions stay at `<rendition>`. On Cloudflare the joined broadcast is
  `<exposure>/live.hang` and the renditions are `<exposure>/<rendition>`. hang resolves `./<rendition>` against the
  catalog's own broadcast as a sibling (`Path.tryResolve`), so the joined catalog is unchanged.
- **Deployment.** The account comes from `CLOUDFLARE_MOQ_ACCOUNT_ID` (text) and `CLOUDFLARE_MOQ_API_TOKEN` (secret),
  an account token allowed to manage MoQ relays. It is separate from the DNS token. When they are unset,
  `cloudflare-moq` gateways answer `503 gateway_unavailable`.
- **No stats.** The provider has no `stats`, so the planner asks for none and the streams page shows no relay traffic
  for these gateways.

### Alternatives considered

- **A built-in `cloudflare` gateway.** One deployment-wide relay would hand every organisation's readers a token for
  every other organisation's streams. A built-in gateway with a relay per organisation would work, but it gives
  organisations no choice. It also creates relays for every organisation that never uses one.
- **Bring your own relay.** An organisation would paste its own relay's tokens into settings. Settings are plain JSON
  that members read, so this needs a secret-settings mechanism. The tokens would also live up to a year, with no
  rotation unless they hand over an API token too. This could be revisited as a second kind.
- **Fronting Cloudflare with gatekeeper.** Gatekeeper can't admit Cloudflare sessions, because Cloudflare has no auth
  callout. Gatekeeper could only proxy token minting, which adds a hop and changes nothing about the scope.
- **Upstream federation.** Cloudflare relays can pull from `config.upstreams` (a `moqt://` or `https://` URL). Our
  moq-relay could be an upstream for Cloudflare's CDN fan-out, but the upstream session would need a long-lived
  relay-wide credential. It is worth a separate look for egress scale.

## Risks and open questions

- **Smoke test (2026-11-06).** I tested the moq CLI 0.14.7 binary the agent ships against an existing relay. The
  test used two 3-hour tokens minted through the API, with the same response shape the provider parses. Both tokens
  were revoked afterwards.
  - **Works.** A token in the URL path is accepted over WebTransport, and `moqt-16` is negotiated (`connected
version=moq-transport-16`).
  - **Works.** An FLV test pattern was published as `smoke-exp/default`. A second session with a subscribe-only token
    exported it back by name and received the catalog, even though that session joined 6 s late. It read 14 s of
    continuous H.264.
  - **Blocker: no WebSocket.** Cloudflare refuses WebSocket (`wss://` and an HTTP upgrade both return 403). The
    agent's joiner runs `@moq/net` on Node, which has no WebTransport, so it falls back to WebSocket. The joiner
    therefore can't connect, and `<exposure>/live.hang` would never be published. The fix is either:
    - a WebTransport implementation for Node, such as `@fails-components/webtransport` installed as the global
      `WebTransport` (a native dependency in the agent's packaging);
    - or skipping the join on Cloudflare, so readers subscribe to a rendition broadcast directly.
  - **Interop bug: audio stops.** About every 10 groups, Cloudflare ends its upstream subscription to the audio track
    with PUBLISH_DONE `closed, code=0`. It then subscribes again, and sometimes sends a FETCH. The audio track here
    has one AAC frame per group, so ~43 groups/s. Every re-subscribe uses a new request ID, and audio stopped after
    about 6 s, consistent with running out of request IDs (MAX_REQUEST_ID support is partial). Video, at 1 group/s,
    was unaffected. The publisher never closed the track, so this looks like a relay behaviour to report to
    Cloudflare or moq-dev.
  - **Not tested yet:** announcement discovery (the joiner's `request(…, { announced: true })` over
    SUBSCRIBE_NAMESPACE), `@moq/watch` playing a nested `<exposure>/live.hang` in a browser, and the studio API path
    end to end.
- **Revocation lag.** A removed member, or a device that is no longer the pinned publisher, stays admitted until its
  token expires (≤ 24 h). Cloudflare checks the token only when a session opens, so revoking a token doesn't end
  sessions already open. Shorter lifetimes would narrow this at the cost of more mints.
- **Tokens in URLs.** Cloudflare warns that path tokens reach access logs. These tokens are relay-wide and shared.
- **Kind changes.** Changing a gateway's kind away from `cloudflare-moq` leaves its relay behind. The relay is deleted
  only when the gateway is removed.
- **Beta API drift.** Response shapes are parsed leniently (`cloudflare-moq-api.ts`), and a refusal surfaces as
  `gateway_unavailable` with Cloudflare's errors as the cause. `GET /moq/relays` is read page by page, by its
  `created_after` cursor, until a page comes back empty.
- **The preview player.** The studio web's preview still plays only the `conservationtv` exposure.
