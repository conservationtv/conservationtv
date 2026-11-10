# versioned-api (Rust)

The Rust counterparts of `@conservationtv/versioned-api`'s client runtime and SDK generator.

- [`client`](client): `versioned-api-client`, the runtime behind a generated `Client`, ported from `src/client`:
  the handshake against `/openapi.json` (conditional once negotiated, one in flight at a time), per-operation
  negotiation, the `Operation-Version` header, the single refresh-and-retry on a 412 version mismatch, errors
  classified by status, and `Authenticate` (`bearer`, or a signer of your own). Requests go through a `Transport`:
  `reqwest` by default, or any `tower::Service` over `http` types (`ServiceTransport`, `ClientConfig::from_service`),
  such as `iroh_http::Client`.
- [`codegen`](codegen): `versioned-api-codegen`, which renders an SDK's `src/generated` from the manifests the
  `rustManifest` Hey API plugin (`src/codegen/rust-manifest.plugin.ts`) writes. Hey API parses the contracts and the
  shared `operationParams`/`flatFields` name them; this renders types with [typify](https://github.com/oxidecomputer/typify)
  and everything else with `quote`/`prettyplease`.

## typify and these contracts

typify 0.8 takes OpenAPI 3.1 component schemas as they are (it resolves `#/components/schemas/<name>` by name).
One rewrite is applied first: Zod renders unions as `anyOf`, which typify turns into a struct of optional flattened
branches, unusable as a path parameter and blind to which branch a value is. A non-nullable `anyOf` is rendered as
`oneOf` instead, which typify makes an untagged enum taking the first branch that matches: `anyOf`'s meaning for a
union. A nullable `anyOf` (`X | null`) is left alone and becomes an `Option`.

What typify drops: `const` on a property inside an object branch (the branch's other differences still tell them apart)
and string formats it has no type for (`uri`, `email`). Lengths and patterns become validating newtypes.
