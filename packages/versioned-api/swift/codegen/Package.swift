// swift-tools-version: 6.0
// versioned-api-codegen: renders a version-aware Swift SDK from the manifests the `rust-manifest` Hey API plugin
// writes, with swift-openapi-generator for the contracts' types. A package of its own, so apps depending on the SDKs
// never resolve the generator's dependencies.
import PackageDescription

let package = Package(
    name: "versioned-api-codegen",
    platforms: [.macOS(.v13)],
    dependencies: [
        // Its library is underscored (no API stability), so it is pinned; the SDKs' OpenAPIRuntime must suit it.
        .package(url: "https://github.com/apple/swift-openapi-generator", exact: "1.9.0")
    ],
    targets: [
        .executableTarget(
            name: "versioned-api-codegen",
            dependencies: [.product(name: "_OpenAPIGeneratorCore", package: "swift-openapi-generator")],
            path: "Sources"
        )
    ]
)
