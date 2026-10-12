# Control plane end-to-end tests

The gatekeeper against the published relay images, run with Testcontainers. Docker and OpenSSL 3 must be available.

```sh
pnpm --filter @conservationtv/controlplane-tests test   # builds fleet, the Worker and SDK first
```

Each file starts Postgres (migrated with gatekeeper's Drizzle migrations) and its relay containers, and runs the
built gatekeeper Worker in Miniflare/workerd through `@conservationtv/gatekeeper/testing`. A host HTTP proxy records relay callouts and forwards them to the Worker. Grants are exchanged through
the generated SDK (`@conservationtv/controlplane-sdk`), and the relays call back into the gatekeeper:

- **moq-relay** (`moq-relay.test.ts`): sessions over the relay's HTTP routes (`/announced`), each admitted or refused
  by gatekeeper's moq-auth callout; two real relays also connect using static peers and an opaque token file, testing both correct and incorrect secrets.
  The peer test uses fleet's production TOML renderer and a temporary server certificate/CA in place of public ACME.
- **iroh-relay** (`iroh-relay.test.ts`): real iroh endpoints (`@number0/iroh`) homing on the relay, admitted only while
  gatekeeper holds a lease for them.

Containers reach the host as `host.docker.internal` (mapped to `host-gateway` on Linux). moq-relay only accepts
`http://` auth URLs on loopback, so a socat sidecar sharing its network namespace forwards to the gatekeeper. The
MoQ image is pinned in `support/relays.ts`. Iroh uses fleet's digest-pinned `IROH_RELAY_IMAGE`
and `renderIrohRelayToml()`, with TLS/QUIC disabled and the HTTP listener exposed for
local containers. The callback token uses the production `IROH_RELAY_HTTP_BEARER_TOKEN`
environment variable. The test script builds fleet before running the suites.

The MoQ peer handshake is real server-authenticated TLS, with no client certificate. MoQ relays carry the gatekeeper
relay key in their auth URL built by fleet's `moqAuthUrl()`, so the real relay sends it as HTTP Basic credentials; a
relay with the wrong key is refused. Certificate generation is local and temporary, and all generated files are
removed when the peer test finishes.
