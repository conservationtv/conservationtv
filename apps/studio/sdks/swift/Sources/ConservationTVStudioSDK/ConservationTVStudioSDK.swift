// A generated version-aware SDK for the conservation.tv studio API: the Swift counterpart of
// `@conservationtv/studio-sdk` and the `conservationtv-studio-sdk` crate, generated from the same contracts with the
// same names. Everything under Generated/ is written by `pnpm generate`; this file is not.
//
// A versioned operation is a handle with a call per version this SDK has (`v1`, `v2`, ...) and the version the server
// negotiated (`version`); a versionless one is a plain call.
//
//     let client = Client(ClientConfiguration(baseURL: url, auth: .bearer(token)))
//     try await client.handshake()  // optional: versioned calls handshake themselves
//     let account = try await client.account.get.v1()

@_exported import VersionedAPIClient
