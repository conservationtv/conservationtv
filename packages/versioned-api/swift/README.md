# versioned-api (Swift)

The Swift counterparts of `@conservationtv/versioned-api`'s client runtime and SDK generator. They are experimental.

- [`Sources/VersionedAPIClient`](Sources/VersionedAPIClient): the runtime behind a generated `Client`, ported from
  `src/client` and `rust/client`. It covers:
  - the handshake against `/openapi.json`: conditional once negotiated, with one in flight at a time;
  - per-operation negotiation, and the `Operation-Version` header;
  - the single refresh-and-retry on a 412 version mismatch;
  - errors classified by status (`APIError`);
  - `Authenticate` (`.bearer`, or a signer of your own).

  It is built on [swift-openapi-runtime](https://github.com/apple/swift-openapi-runtime): requests go through any
  `ClientTransport`, `URLSessionTransport` by default. It is a library of the repository's root `Package.swift`.
- [`codegen`](codegen): `versioned-api-codegen`, a package of its own, so apps never resolve its dependencies. It
  renders an SDK's `Generated` folder from the manifests the `rustManifest` Hey API plugin
  (`src/codegen/rust-manifest.plugin.ts`) writes. Hey API parses the contracts, and the shared
  `operationParams`/`flatFields` name them. [swift-openapi-generator](https://github.com/apple/swift-openapi-generator)
  renders the types, through its `_OpenAPIGeneratorCore` library, as typify does for Rust. This renders everything
  else.

## swift-openapi-generator and these contracts

Each contract becomes one in-memory document for the generator. Its components are the schemas the contract's
operations use, plus one schema per Params field and response, named as its Swift type is (`AccountUpdateV1Image`).
Only the generated `Components` namespace is kept, inside the contract's namespace. Where the generator renders a
field's schema as a typealias, Params spell out the aliased type (`String?`).

Zod's output is rewritten first (`codegen/Sources/Schemas.swift`):

- `X | null` is `anyOf: [X, {type: null}]`. The generator skips null branches, and then drops the member. A nullable
  member becomes optional instead: null and absent both decode as `nil`, and `nil` is left out when encoding. Other
  nullable schemas become `type: [T, null]`. The SDK's own Params still tell absent (`nil`) from null (`.some(nil)`).
- `z.json()` recurses through a union of every JSON kind, which the generator declares no type for. It becomes an empty
  schema, which the generator renders as `OpenAPIValueContainer`.
- Any other `anyOf` becomes `oneOf`, as for typify: an enum that takes the first branch that decodes. Its branches are
  made components, so their cases can be named. The generator only names cases well for a `oneOf` with a
  `discriminator`, and that needs each branch to be a component.
  - Where every branch fixes the same required member to a different value (`driver: "axis"`), that member becomes the
    union's `discriminator`. The generator then names each case after its value (`.axis`), and decodes the branch
    that value names.
  - Otherwise, each branch is named after what only it has: a fixed value, a required member, or a format
    (`.conservationtv`, `.url`, `.ipv4`). If nothing sets one branch apart, it is `.other`. The generator names these
    cases after their components exactly (`case GatewayGetV1GatewayIdUuid`), so the cases are renamed in its output.

Anything the generator still can't render is an error, not a member left out. Its warnings fail the generation.

`_OpenAPIGeneratorCore` is underscored (it has no API stability promise), so the generator is pinned to an exact version.
