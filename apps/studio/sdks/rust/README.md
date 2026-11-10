# Studio SDK (Rust)

`conservationtv-studio-sdk`: the version-aware Rust SDK for the studio API, generated from the same contracts, with
the same operation tree and Params names, as the TypeScript SDK in [`../ts`](../ts). The runtime and generator are
[`packages/versioned-api/rust`](../../../../packages/versioned-api/rust).

```rust
use conservationtv_studio_sdk::{Client, ClientConfig, Error, bearer};
use conservationtv_studio_sdk::versions::account_update_v1::AccountUpdateV1Params;

let client = Client::new(ClientConfig::new("http://localhost:6421").with_auth(bearer(token)));
client.handshake().await?; // optional: versioned calls handshake themselves
let health = client.health().get().await?; // versionless: a plain call
let account = client.account().get().v1().await?; // versioned: one call per version this SDK has
let mut update = AccountUpdateV1Params::new();
update.image = Some(None); // absent (None) and null (Some(None)) differ, as `undefined` and `null` do in TypeScript
match client.account().update().v1(update).await {
    Err(Error::NotAuthorized(error)) => eprintln!("{} ({:?})", error.message, error.code),
    other => println!("{other:?}"),
}
```

`client.account().get().version()` is the version negotiated with the server. As in TypeScript, a version the server
doesn't serve fails before it is sent (`Error::OperationVersionUnavailable`), and a version withdrawn between the
handshake and a call (a 412 naming `Operation-Version`) refreshes and fails with `Error::OperationVersionChanged`
rather than resending arguments built for the old version.

## Transports

Requests, the handshake included, go through a `Transport`: `reqwest` by default (the `reqwest` feature), or any
`tower::Service` over `http` types through `ClientConfig::from_service`, the counterpart of the TypeScript SDK's custom
`fetch`. `iroh_http::Client` is one, so the SDK can talk to a peer over an Iroh connection:

```rust
let iroh = iroh_http::Client::connect(&endpoint, address).await?;
// Over Iroh only the path and query are sent; the authority just has to make a valid URL.
let client = Client::new(ClientConfig::from_service(format!("http://{}", iroh.endpoint_id()), iroh));
```

Build with `default-features = false` to leave reqwest out. Bodies are read whole, and `RequestOptions::timeout` needs a
Tokio runtime with its timer enabled.

## Generate

Run `pnpm generate` here after `../ts`'s, whenever the API's contracts change. It runs `openapi-ts.config.ts`, which
writes `.generate/` with the same jobs and `minimumVersions` as the TypeScript SDK, then renders `src/generated` with
`versioned-api-codegen`:

- `versions/<operation>_vN.rs`: one module per frozen operation contract. Its types are typify's, strict (unknown
  fields are rejected where the contract says `additionalProperties: false`), since a contract never changes.
- `current.rs`: the versionless operations, from the current spec. Their types accept fields the server adds.
- `client.rs`: the `Client` operation tree.

The flat Params names and fields come from `flatFields` in `@conservationtv/versioned-api/codegen`, the function the
TypeScript SDK and CLI use, so the SDKs can't drift apart on them.

## Not yet ported

- `DeviceIdentity` / `deviceSignature` (RFC 9421 device signing, `../ts/src/device.ts`): implement
  `versioned_api_client::Authenticate` for it.
- The CLI (`../../cli`, Incur): a `clap` renderer of the same tree would be its Rust counterpart.
