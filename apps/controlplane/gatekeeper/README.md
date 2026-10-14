# Gatekeeper

The conservation.stream control plane: a **relay capability broker** for the MoQ and Iroh relays. Application APIs
(consumers) authenticate their own users, decide what they may do, and sign a complete grant request. Gatekeeper
verifies that signed assertion, enforces the consumer's delegation ceiling, and issues relay credentials:

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
| `POST /grants/exchange`       | consumers  | `grants.exchange` v1 (`Operation-Version: 1`)                             |
| `GET /openapi.json`           | SDK/CLI    | the published capability bundle                                           |
| `POST /relays/moq/admission`  | MoQ relay  | moq-relay `--auth-url`: a moq-auth `Request` in, a `Grant` or 401/403 out |
| `POST /relays/iroh/admission` | Iroh relay | iroh-relay `access.http`: `200 true` admits, anything else refuses        |

Relay-facing routes speak each relay's fixed protocol, so they are hidden from the published contract, SDK and CLI.
Signing keys are never published: the control plane is the only party that verifies its own MoQ tokens.

## Grant exchange

`POST /grants/exchange` takes exactly `{ "grant_assertion": "<compact JWS>" }`. Everything security-relevant
(subject, capabilities, lifetime) lives inside the signed assertion. The order of checks follows the design
document; see `src/grants/exchange.ts`:

1. **Envelope**: strict JSON (duplicate members are refused), compact JWS, protected header of exactly `alg`, `kid`
   and `typ`. `jku`, `x5u`, `jwk`, `x5c`, `crit` and `b64` are refused.
2. **Registration**: an exact `iss` + `sub` match. The unverified values only select a candidate.
3. **Key**: from the registered `jwks_uri` only, by `kid`, unless the `kid` is in `denied_key_ids`.
4. **Header**: `typ` must be `relay-grant+jwt`, and `alg` must be one the consumer registered.
5. **Signature and claims**: exact `iss`, `sub`, `aud`; `iat ≤ nbf < exp`; 30 s clock skew; lifetime ≤ the registered
   maximum; unknown claims refused; consumer enabled.
6. **Grant schema** (only now is `grant` read): `version: 1`, strict at every level, bounded sizes, canonical paths
   (no empty, `.`, `..`, wildcard or encoded segments), lowercase-hex Ed25519 endpoint IDs.
7. **Subject**: must start with a registered `<prefix>:`.
8. **Delegation**: the MoQ root is at or beneath a registered root (on segment boundaries), and each action and Iroh
   access is delegated. Requests are accepted or rejected as signed, never widened or trimmed.
9. **Issue**: in one transaction, consume the `jti`, write the grant audit record, sign the MoQ token and create the
   Iroh lease. An endpoint actively leased to a different consumer is refused. A rejection leaves nothing behind.

The credential lifetime is the lowest of the requested `expires_in`, the consumer's maximum,
`MAX_CREDENTIAL_LIFETIME_SECONDS` and 24 hours.

Failures use `{ "error", "error_description" }` with fixed, non-revealing descriptions: 400 for malformed requests and
grants, 401 for authentication and assertion failures, 403 for requests outside the delegation, and 503 when a needed
dependency (consumer JWKS, database) is unavailable. Every response is `Cache-Control: no-store`.

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
Gatekeeper verifies the ES256 signature and recorded grant, checks revocation and consumer enablement, and scopes
permissions to the dialed path. Grants expire with the token and revalidate every 60 seconds. A consumer token never receives `peer: true`.

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

An endpoint is admitted while it holds an active, unexpired lease. The lease's grant must not be revoked, its
consumer must still be registered and enabled, and the endpoint must not be in `deniedIrohEndpoints`.
Iroh v1.3.0 performs this check on connection; expiry and revocation prevent subsequent
connections but do not terminate an already admitted connection. Both
`X-Iroh-Endpoint-Id` and the deprecated `X-Iroh-NodeId` are accepted; iroh-relay v1.3.0 still sends only the latter.

### Consumer JWKS

Fetched only from the registered HTTPS URI, which must be a public DNS name. Redirects are refused. Documents are
limited to 64 KiB and 16 keys, and any private or symmetric key material is refused. Key sets are cached in isolate
memory and in Postgres, fresh for the server's `max-age` clamped to 1 minute–1 hour. After that they are refreshed
opportunistically but still used for one more hour if the consumer's JWKS is down, then refused (fail closed). An
unknown `kid` triggers at most one refresh per 30 seconds.

## Configuration

Consumer registrations and endpoint denials are JSON arrays in the `CONSUMER_REGISTRATIONS` and
`DENIED_IROH_ENDPOINTS` Worker environment bindings. The build supplies defaults from
`src/config/registrations.ts`; override the bindings per deployment or in `.dev.vars` for local development.
An override replaces the entire list, so `[]` explicitly clears it. Empty strings, malformed JSON, invalid entries
and duplicate consumer identities fail every request rather than falling back to defaults.
Policy is validated and cached on the first request in each isolate; apply changes through a deployment/restart.
Revocation options are:

- set `enabled: false` in `CONSUMER_REGISTRATIONS`;
- add a `kid` to `denied_key_ids`;
- add an endpoint to `DENIED_IROH_ENDPOINTS`;
- set `grants.revoked_at`, which immediately stops Iroh admission for that grant's leases.

| Binding                           | Kind              | Purpose                                                          |
| --------------------------------- | ----------------- | ---------------------------------------------------------------- |
| `CONSUMER_REGISTRATIONS`          | text (JSON array) | Complete consumer registrations; defaults to the checked-in list |
| `DENIED_IROH_ENDPOINTS`           | text (JSON array) | Denied endpoint IDs; defaults to the checked-in list             |
| `HYPERDRIVE`                      | Hyperdrive        | PlanetScale Postgres, uncached; ID from the controlplane stack   |
| `MOQ_SIGNING_KEYS`                | secret            | `{ active_kid, keys: [private ES256 JWK…] }`                     |
| `IROH_RELAY_TOKEN`                | secret            | shared with the Iroh relay's `access.http.bearer_token`          |
| `MOQ_RELAY_TOKEN`                 | secret            | Pulumi-generated key MoQ relays present on admission callbacks   |
| `MOQ_CLUSTER_TOKEN`               | secret            | Pulumi-generated opaque credential shared by MoQ peers           |
| `MAX_CREDENTIAL_LIFETIME_SECONDS` | text              | environment ceiling on credential lifetimes                      |

The controlplane Pulumi stack owns the Worker, its Hyperdrive config and every secret, including the signing keys.
`pnpm upload` uploads a version without deploying it; the Hyperdrive ID comes from that stack's outputs, passed as
`STACK_OUTPUT_JSON`. CI releases it on pushes to `main`, as described in the
[controlplane README](../infrastructure/README.md#release-gatekeeper), which also covers key rotation.

`pnpm keys:generate [kid]` prints a `MOQ_SIGNING_KEYS` value for local development.

A cron trigger (every 15 minutes) purges expired replay identifiers and leases that expired over a day ago. Grant
audit records are kept.

## Develop

```sh
pnpm install
pnpm --filter @conservationtv/gatekeeper db:up       # docker-compose Postgres on :5433
pnpm --filter @conservationtv/gatekeeper db:migrate
cp .dev.vars.example .dev.vars                       # then paste `pnpm keys:generate` output
pnpm --filter @conservationtv/gatekeeper dev
pnpm --filter @conservationtv/gatekeeper test        # builds Worker, then tests in workerd; needs db:up
```

Tests run the production `cf build` output in Miniflare/workerd, including `src/index.ts`, its configuration
validation, signing-key loading and per-request database connections. Node/Vitest uses ordinary HTTP requests to the
Worker's local server. Relay tests additionally use Miniflare's trusted `cf` metadata injection to model the
Cloudflare edge; there is no application auth bypass or trusted-header fallback. Postgres is real; the external consumer JWKS endpoint is controlled at the runtime's
outbound HTTP boundary. No application services or Worker clock are replaced. Each case starts a fresh Worker and
clears the shared database, so files run serially. Each suite explicitly owns and closes its Worker and database;
configuration changes use `worker.restart(bindings)`. For a focused run, build first, then use `pnpm exec vitest run <file>`.

Expiry cases issue short-lived credentials and observe admission until expiry. JWKS cache cases age persisted
records and restart the Worker to exercise cold-isolate recovery, freshness and stale-use limits without waiting
an hour. They cover those persisted-cache transitions, rather than advancing a live isolate's clock.

End-to-end tests against real relay images live in [`../tests`](../tests). They use the same built-Worker harness
through `@conservationtv/gatekeeper/testing`, with isolated Postgres containers and the generated SDK.

Schema changes: edit `src/db/schema.ts`, then `pnpm db:generate` and commit the migration in `drizzle/`.

Request handling reads its dependencies through `services()` (AsyncLocalStorage, `src/services.ts`). Only the
production Worker entrypoint constructs those dependencies.

## Contracts, SDK and CLI

```sh
pnpm --filter @conservationtv/gatekeeper generate             # contracts/openapi.json from routes + handler types
pnpm --filter @conservationtv/controlplane-sdk generate
pnpm --filter @conservationtv/controlplane-cli generate
GATEKEEPER_URL=http://localhost:5173 pnpm --filter @conservationtv/controlplane-cli cli grants exchange v1 --grant_assertion <jwt>
```

Release snapshots work as in the reference: `pnpm snapshot gatekeeper-v1.0.0` freezes the current bundle under
`contracts/snapshots/`, and `check:snapshot`, `check:release` and `ci:contracts` gate releases. These scripts are the shared
`api-contracts` command reading `contracts.config.ts`. No snapshot has been cut yet, so every contract is still
provisional.

Toolchain note: worker type-checking uses TypeScript 7. Response inference and Hey API need the TypeScript compiler
API, which TypeScript 7 does not ship, so the shared package and the SDK and CLI use TypeScript 6.
