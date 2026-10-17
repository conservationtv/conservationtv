# Gatekeeper

The conservation.stream control plane: a **relay capability broker** for the MoQ and Iroh relays. Each environment
(local, staging, prod) has its own gatekeeper and relays, and one **consumer token**: whoever holds it (the studio API,
or a trusted developer's local one against staging) authenticates its own users, decides what they may do, and asks
for relay credentials on their behalf. Gatekeeper records each grant and issues:

- a control-plane-signed **moq-relay token**, and/or
- a short-lived **Iroh endpoint lease**, checked by the Iroh relay's access callout.

It is a Cloudflare Worker (Hono) backed by Postgres through Hyperdrive. Its API is versioned per operation and
publishes an OpenAPI bundle from which the SDK (`../sdk`) and CLI (`../cli`) are generated, following
[perfect-versioned-api](../../../../personal/perfect-versioned-api). The versioning router, contract generation,
release gates and SDK/CLI generators are shared through [`@conservationtv/versioned-api`](../../../packages/versioned-api).

## Endpoints

| Route                         | Audience   | Contract                                                                  |
| ----------------------------- | ---------- | ------------------------------------------------------------------------- |
| `GET /health`                 | anyone     | `health.get`, versionless                                                 |
| `POST /grants/exchange`       | consumer   | `grants.exchange` v1 (`Operation-Version: 1`), with the consumer token    |
| `GET /openapi.json`           | SDK/CLI    | the published capability bundle                                           |
| `POST /relays/moq/admission`  | MoQ relay  | moq-relay `--auth-url`: a moq-auth `Request` in, a `Grant` or 401/403 out |
| `POST /relays/iroh/admission` | Iroh relay | iroh-relay `access.http`: `200 true` admits, anything else refuses        |

Relay-facing routes speak each relay's fixed protocol, so they are hidden from the published contract, SDK and CLI.
Signing keys are never published: the control plane is the only party that verifies its own MoQ tokens.

## Grant exchange

`POST /grants/exchange` requires the environment's consumer token as `Authorization: Bearer <CONSUMER_TOKEN>`, compared
with the fixed-length digest comparison the relay callbacks use, and takes the grant itself as strict JSON (duplicate
members and unknown fields are refused at every level):

```json
{
  "subject": "studio:device:42",
  "requested_capabilities": {
    "moq": { "root": "org/stream", "publish": ["camera"], "subscribe": [] },
    "iroh": { "endpoint_id": "<lowercase hex Ed25519 public key>", "action": "connect" }
  },
  "expires_in": 3600
}
```

`subject` is the consumer's own label for who the credentials are for, kept for audit. Paths are canonical (no empty,
`.`, `..`, wildcard or encoded segments), at most one of each capability, and at least one. The consumer is trusted
with the environment's relays, so the grant is issued as asked: there are no per-consumer namespaces or delegation
ceilings. The only refusal beyond validation is an endpoint in `DENIED_IROH_ENDPOINTS`. In one transaction, gatekeeper
writes the grant audit record, signs the MoQ token and creates the Iroh lease; a rejection leaves nothing behind.

The credential lifetime is the lowest of the requested `expires_in`, `MAX_CREDENTIAL_LIFETIME_SECONDS` and 24 hours.

Failures use `{ "error", "error_description" }` with fixed, non-revealing descriptions: 400 `invalid_request` for
malformed requests, 401 `invalid_token` without the consumer token, 403 `invalid_endpoint_id` for a denied endpoint,
and 503 when the database is unavailable. Every response is `Cache-Control: no-store`.

### MoQ tokens

Signed with the control plane's own ES256 key (`kid` = the active key). Tokens carry only `root`, `publish`,
`subscribe`, `iat`, `exp` and `jti` (the grant ID), the claim set moq tooling understands. Each requested path
authorises its subtree (`camera` → `camera/**`); the empty path authorises the whole root (`**`). `sub` is
deliberately omitted because older moq-token releases read it as the subscribe list.

moq-relay 0.17.2 asks gatekeeper about each session. Relay callbacks authenticate with a shared relay key,
`MOQ_RELAY_TOKEN`. moq-relay has no header setting for its auth callout, so the key is userinfo in its auth URL
(`https://moq-relay:<key>@<gatekeeper>/relays/moq/admission`), which the relay sends as HTTP Basic credentials.
Gatekeeper compares the Basic password with the fixed-length digest comparison and ignores the username. There is
no node registry; the callback's `node` field is informational. Invalid callback authentication gets 401, a
refused session gets 403, and an accepted `end` event gets 204.

For consumer sessions, the client's token comes from `?jwt=` or a type 0 SETUP token (both only if they agree).
Gatekeeper verifies the ES256 signature and recorded grant, checks revocation, and scopes permissions to the dialed
path. Grants expire with the token and revalidate every 60 seconds. A consumer token never receives `peer: true`.

### Peer authentication

Infrastructure writes static peer addresses into each relay's `cluster.connect`. Pulumi's `random.RandomBytes`
generates a 32-byte shared cluster secret, encoded as lowercase hex. Fleet writes it to a `0600` file and installs
the same value as gatekeeper's secret `MOQ_CLUSTER_TOKEN` binding. There is no node registry, peer-list endpoint,
peer JWT issuance or client-CA bundle on the relays.

```toml
[listen.tls]
cert = "/etc/moq/certs/public/node/fullchain.pem"
key = "/etc/moq/certs/public/node/privkey.pem"

[web.https]
listen = "[::]:443"
cert = "/etc/moq/certs/public/node/fullchain.pem"
key = "/etc/moq/certs/public/node/privkey.pem"

[cluster]
node = "https://relay-1.example.com/"
connect = ["https://relay-2.example.com/"]
token = "/etc/moq/secrets/cluster-token"

[stats]
node = "relay-1"
```

The auth URL is not in `relay.toml`: fleet passes it as the `MOQ_AUTH_URL` environment variable from the `0600`
compose file, because it carries the relay key. Peer connections use normal server-authenticated TLS with public
ACME certificates. No client certificates are used anywhere.

MoQ reads `cluster.token` at startup and presents its contents using the `jwt` query parameter. Despite that
parameter name, this credential is an opaque secret, not a JWT. Gatekeeper compares it with `MOQ_CLUSTER_TOKEN`
using the existing fixed-length digest comparison. Only root QUIC/WebSocket sessions receive full publish/subscribe
permissions and `peer: true`. Missing or wrong secrets fail; an unset binding admits no peers. Client certificate
facts in the session JSON grant no access. Consumer JWTs continue through their separate signature and grant checks.

Peer grants revalidate every 60 seconds and expire 24 hours after the latest one, which bounds only how long peers
outlive a gatekeeper outage. The shared credential has no built-in expiry; Pulumi preserves it across deployments.
Advance the cluster token's `random.RandomBytes` keeper (`clusterTokenGeneration` in the controlplane stack) to replace it explicitly, update the Worker secret binding,
and roll the relays. Fleet recreates relays when it changes so they reread the token file. This single-secret policy
has no overlap: old sessions fail subsequent revalidation after the Worker update, and reconnect with the new
credential once their relay is updated. All cluster peers share the same authority; there is no per-node revocation.

Deploy gatekeeper with secrets `MOQ_RELAY_TOKEN` (the relay key) and `MOQ_CLUSTER_TOKEN` (the cluster token)
before starting relays. The relay key rotates the same way as the cluster token: replace it, update the Worker
binding and roll the relays. Iroh's bearer-authenticated callback is unchanged.

### Iroh leases

Point the relay at the callout:

```toml
access.http.url = "https://<gatekeeper>/relays/iroh/admission"
access.http.bearer_token = "<IROH_RELAY_TOKEN>"
```

Fleet's `IrohRelayWorkload` takes `admissionUrl` pointing to this endpoint and
`admissionToken` matching `IROH_RELAY_TOKEN`. It supplies the token through
`IROH_RELAY_HTTP_BEARER_TOKEN`, which iroh-relay uses for the callback's Authorization
header. The default relay image is pinned to v1.3.0 and its multi-platform digest.

An endpoint is admitted while it holds an active, unexpired lease. The lease's grant must not be revoked, and the
endpoint must not be in `DENIED_IROH_ENDPOINTS`.
Iroh v1.3.0 performs this check on connection; expiry and revocation prevent subsequent
connections but do not terminate an already admitted connection. Both
`X-Iroh-Endpoint-Id` and the deprecated `X-Iroh-NodeId` are accepted; iroh-relay v1.3.0 still sends only the latter.

## Configuration

All bindings are declared by `config` in `src/env/config.ts` (ArkEnv over `process.env`) and parsed on the first
request in each isolate; an invalid one fails every request rather than falling back to a default. Apply changes
through a deployment/restart. Revocation options are:

- rotate `CONSUMER_TOKEN`, which stops new exchanges (issued credentials last until they expire or are revoked);
- add an endpoint to `DENIED_IROH_ENDPOINTS`;
- set `grants.revoked_at`, which immediately stops Iroh admission for that grant's leases and closes its MoQ sessions
  at their next revalidation.

| Binding                           | Kind              | Purpose                                                        |
| --------------------------------- | ----------------- | -------------------------------------------------------------- |
| `CONSUMER_TOKEN`                  | secret            | Pulumi-generated token the environment's consumer presents     |
| `DENIED_IROH_ENDPOINTS`           | text (JSON array) | Denied endpoint IDs; `[]` by default                           |
| `HYPERDRIVE`                      | Hyperdrive        | PlanetScale Postgres, uncached; ID from the controlplane stack |
| `MOQ_SIGNING_KEYS`                | secret            | `{ active_kid, keys: [private ES256 JWK…] }`                   |
| `IROH_RELAY_TOKEN`                | secret            | shared with the Iroh relay's `access.http.bearer_token`        |
| `MOQ_RELAY_TOKEN`                 | secret            | Pulumi-generated key MoQ relays present on admission callbacks |
| `MOQ_CLUSTER_TOKEN`               | secret            | Pulumi-generated opaque credential shared by MoQ peers         |
| `MAX_CREDENTIAL_LIFETIME_SECONDS` | text              | environment ceiling on credential lifetimes                    |

Each controlplane Pulumi stack (`staging`, `prod`) owns its Worker, Hyperdrive config and every secret, including the
signing keys and the consumer token (`pulumi stack output gatekeeperConsumerToken --show-secrets`).
`pnpm upload` uploads a version without deploying it; the Hyperdrive ID comes from that stack's outputs, passed as
`STACK_OUTPUT_JSON`. CI releases it on pushes to `main`, as described in the
[controlplane README](../infrastructure/README.md#release-gatekeeper), which also covers key rotation.

A cron trigger (every 15 minutes) purges leases that expired over a day ago. Grant audit records are kept.

## Develop

The local environment runs everything on this machine: Postgres and both relays in docker compose, gatekeeper's dev
server on the host, which the relays call back to through `host.docker.internal:5176`.

```sh
pnpm install
pnpm --filter @conservationtv/gatekeeper local:up     # Postgres on :5433, iroh-relay on :3340, moq-relay on :4433/:4443
pnpm --filter @conservationtv/gatekeeper db:migrate
cp .dev.vars.example .dev.vars                       # then generate MOQ_SIGNING_KEYS as it describes
pnpm --filter @conservationtv/gatekeeper dev         # http://localhost:5176
pnpm --filter @conservationtv/gatekeeper test        # builds Worker, then tests in workerd; needs db:up
```

The local tokens are fixed in `.dev.vars.example`, the compose file and the studio API's `.dev.vars.example`, so the
studio API only needs its commented gatekeeper lines enabled to lease endpoints on the local iroh-relay
(`IROH_RELAY_URL=http://localhost:3340`). iroh-relay runs in `--dev` mode over plain HTTP. moq-relay generates a
certificate for `localhost` and publishes its hash at `http://localhost:4443/certificate.sha256`, for WebTransport's
`serverCertificateHashes`. `pnpm db:up` starts Postgres alone; `pnpm local:down` stops everything.

To use staging's relays from a local studio API instead, set its `GATEKEEPER_URL`, `GATEKEEPER_TOKEN` and
`IROH_RELAY_URL` to staging's, as its `.dev.vars.example` shows; no local gatekeeper is involved.

Tests run the production `cf build` output in Miniflare/workerd, including `src/index.ts`, its configuration
validation, signing-key loading and per-request database connections. Node/Vitest uses ordinary HTTP requests to the
Worker's local server. Relay tests additionally use Miniflare's trusted `cf` metadata injection to model the
Cloudflare edge; there is no application auth bypass or trusted-header fallback. Postgres is real. No application services or Worker clock are replaced. Each case starts a fresh Worker and
clears the shared database, so files run serially. Each suite explicitly owns and closes its Worker and database;
configuration changes use `worker.restart(bindings)`. For a focused run, build first, then use `pnpm exec vitest run <file>`.

Expiry cases issue short-lived credentials and observe admission until expiry, rather than advancing the Worker's
clock.

End-to-end tests against real relay images live in [`../tests`](../tests). They use the same built-Worker harness
through `@conservationtv/gatekeeper/testing`, with isolated Postgres containers and the generated SDK.

Schema changes: edit `src/db/schema.ts`, then `pnpm db:generate` and commit the migration in `drizzle/`.

Request handling reads its dependencies through `useEnvironment()`, a `createStore` from `@conservationtv/store`
(AsyncLocalStorage, `src/env/env.ts`): the deployment's `variables` and the clients built from them. Only the
production Worker entrypoint creates it, through `createEnvironment` (`src/env/config.ts`), whose `services`
initialises every client that uses some configuration.

## Contracts, SDK and CLI

```sh
pnpm --filter @conservationtv/gatekeeper generate             # contracts/openapi.json from routes + handler types
pnpm --filter @conservationtv/controlplane-sdk generate
pnpm --filter @conservationtv/controlplane-cli generate
GATEKEEPER_URL=http://localhost:5176 GATEKEEPER_TOKEN=local-consumer-token pnpm --filter @conservationtv/controlplane-cli \
  cli grants exchange v1 --subject cli:me --requested_capabilities '{"iroh":{"endpoint_id":"<id>","action":"connect"}}' \
  --expires_in 300
```

Release snapshots work as in the reference: `pnpm snapshot gatekeeper-v1.0.0` freezes the current bundle under
`contracts/snapshots/`, and `check:snapshot`, `check:release` and `ci:contracts` gate releases. These scripts are the shared
`api-contracts` command reading `contracts.config.ts`. No snapshot has been cut yet, so every contract is still
provisional.

Toolchain note: every package type-checks with TypeScript 7 (the workspace catalog). Response inference and Hey API
need the TypeScript compiler API, which TypeScript 7 does not ship: the shared package imports TypeScript 6 as
`typescript-api`, and `.pnpmfile.cjs` gives Hey API (and Pulumi) a TypeScript 6 of their own.
