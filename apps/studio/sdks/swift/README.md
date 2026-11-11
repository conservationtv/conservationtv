# Studio SDK (Swift)

`ConservationTVStudioSDK`: the version-aware Swift SDK for the studio API, for iOS and other Apple platforms. It is
generated from the same contracts as the TypeScript SDK in [`../ts`](../ts) and the Rust SDK in [`../rust`](../rust),
with the same operation tree and Params names. It is experimental. The runtime and generator are in
[`packages/versioned-api/swift`](../../../../packages/versioned-api/swift).

It is a library of the repository's root `Package.swift`, so an app can add this repository as a package dependency
(or a local checkout, in Xcode, with *Add Local…*) and link `ConservationTVStudioSDK`.

```swift
import ConservationTVStudioSDK

let client = Client(ClientConfiguration(baseURL: URL(string: "http://localhost:6421")!, auth: .bearer(token)))
try await client.handshake() // optional: versioned calls handshake themselves
let health = try await client.health.get() // versionless: a plain call
let account = try await client.account.get.v1() // versioned: one call per version this SDK has
// Absent (nil) and null (.some(nil)) differ, as `undefined` and `null` do in TypeScript.
do {
    _ = try await client.account.update.v1(.init(image: .some(nil)))
} catch .notAuthorized(let error) {
    print(error.message, error.code ?? "")
}
```

Calls use typed throws, so `catch` sees an `APIError`. `client.account.get.version` is the version negotiated with the
server: one of the operation's `Version` cases, or `nil` if the server serves none of this SDK's. As with TypeScript's
`1 | 2` union, a `switch` over it is exhaustive, so regenerating with a new version flags each switch that doesn't
handle it:

```swift
let update = client.account.update
switch try update.version {  // throws before a handshake
case .v1?: _ = try await update.v1(.init(name: "Jo"))
case nil: print("No version of \(Operations.AccountUpdate.operationID) this app knows")
}
```

`Operations.AccountUpdate.Version.allCases` lists the versions this SDK has. As in TypeScript, calling a version the server doesn't serve fails before anything is sent
(`.operationVersionUnavailable`). If a version is withdrawn between the handshake and a call (a 412 naming
`Operation-Version`), the client refreshes and fails with `.operationVersionChanged`, rather than resending arguments
built for the old version.

Unions are enums with a case per branch, named after what sets it apart: the value of the member that discriminates
them (`settings` is `.axis(…)` or `.rtsp(…)`), or otherwise the literal, format or required member only that branch has
(`gatewayId` is `.conservationtv` or `.uuid(…)`; a path's `source` is `.url(…)` or `.path(…)`). A branch still spells its
own tag when built, as in `.axis(.init(driver: .axis, host: host, resolutions: []))`, since it is what's sent.

Each frozen contract's types are in its own namespace, like `Versions.AccountUpdateV1`. The flat Params are there
(`Versions.AccountUpdateV1.AccountUpdateV1Params`), as are the response (`…AccountUpdateV1Response`) and the schemas
both use (`Versions.AccountUpdateV1.Components.Schemas.Account`). Type inference means you rarely spell them out.

## Transports

Requests, the handshake included, go through a swift-openapi-runtime `ClientTransport`. `URLSessionTransport` is the
default. Any other `ClientTransport` works too, the counterpart of the TypeScript SDK's custom `fetch` and the Rust
SDK's `tower::Service`: `AsyncHTTPClientTransport`, or one of your own over another connection. Credentials go
through `Authenticate`, which sees each finished request and its body, so it can sign as well as send a token.

## Generate

Run `pnpm generate` here, after `../ts`'s, whenever the API's contracts change. It has two steps:

1. `openapi-ts.config.ts` writes `.generate/`, with the same jobs and `minimumVersions` as the other SDKs.
2. `versioned-api-codegen` renders `Sources/ConservationTVStudioSDK/Generated` from it:
   - `Versions/<Operation>V<N>.swift`: one namespace per frozen operation contract. Its schemas are
     [swift-openapi-generator](https://github.com/apple/swift-openapi-generator)'s, and its Params and response are
     ours. The schemas are strict: unknown members are rejected where the contract says `additionalProperties: false`.
   - `Current.swift`: the versionless operations, from the current spec. Their types accept members the server adds.
   - `Client.swift`: the `Client` operation tree.

The flat Params names and fields come from `flatFields` in `@conservationtv/versioned-api/codegen`, the function the
other SDKs and the CLI use, so the SDKs can't drift apart on them.

## Not yet ported

- `DeviceIdentity` / `deviceSignature` (RFC 9421 device signing, `../ts/src/device.ts`): conform a signer to
  `Authenticate`.
